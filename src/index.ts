import { Hono } from "hono";
import { ChatSession } from "./do/ChatSession";

export { ChatSession };

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  CHAT_SESSION: DurableObjectNamespace;
  ASSETS: Fetcher;
  MODEL_PRIMARY: string;
  MODEL_GUARD: string;
  EMBED_MODEL: string;
  ADMIN_KEY?: string;
  CS_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Konsol CS, riwayat mentah sesi, dan audit log SEBELUMNYA terbuka tanpa autentikasi apa pun
// (celah terbesar yang ditemukan review) — siapa saja yang tahu sessionId bisa melihat/membalas
// sebagai CS. Ditambahkan shared-secret token demo (BUKAN auth produksi/SSO/RBAC, lihat README
// §Keputusan Desain) sebagai lapisan minimum: header x-cs-token untuk REST, query ?token= untuk
// WS (browser tidak bisa mengirim header kustom saat handshake WebSocket).
async function requireCsToken(c: any, next: () => Promise<void>) {
  const token = c.req.header("x-cs-token") ?? c.req.query("token");
  if (!c.env.CS_TOKEN || token !== c.env.CS_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
}
app.use("/api/cs/*", requireCsToken);
app.use("/api/audit/*", requireCsToken);
app.use("/api/chat/:sessionId/history", requireCsToken);

function getDO(env: Env, sessionId: string) {
  const id = env.CHAT_SESSION.idFromName(sessionId);
  return env.CHAT_SESSION.get(id);
}

function forwardToDO(stub: DurableObjectStub, originalRequest: Request, pathname: string, extraParams: Record<string, string>) {
  const url = new URL(originalRequest.url);
  url.pathname = pathname;
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  // `new Request(url, originalRequest)` menyalin method/headers/body (termasuk header Upgrade untuk
  // WebSocket) dari request asli -> DO menerima handshake WS yang sama persis yang dikirim klien.
  return stub.fetch(new Request(url.toString(), originalRequest));
}

app.get("/api/chat/:sessionId/ws", async (c) => {
  const sessionId = c.req.param("sessionId");
  const stub = getDO(c.env, sessionId);
  return forwardToDO(stub, c.req.raw, "/ws", { sessionId, role: "customer" });
});

app.get("/api/cs/:sessionId/ws", async (c) => {
  const sessionId = c.req.param("sessionId");
  const stub = getDO(c.env, sessionId);
  return forwardToDO(stub, c.req.raw, "/ws", { sessionId, role: "cs" });
});

app.post("/api/chat/:sessionId/message", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{ text: string; persona?: string }>();
  if (!body?.text || typeof body.text !== "string" || body.text.length > 2000) {
    return c.json({ error: "text wajib diisi, maksimal 2000 karakter" }, 400);
  }
  const persona = body.persona === "pendana" || body.persona === "petugas" ? body.persona : "mitra";

  const stub = getDO(c.env, sessionId);
  const res = await stub.fetch(`https://do/message?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    body: JSON.stringify({ text: body.text, persona }),
    headers: { "content-type": "application/json" },
  });
  const data = await res.json<any>();
  return c.json(data);
});

app.get("/api/chat/:sessionId/history", async (c) => {
  const sessionId = c.req.param("sessionId");
  const stub = getDO(c.env, sessionId);
  const res = await stub.fetch(`https://do/history?sessionId=${encodeURIComponent(sessionId)}`);
  return c.json(await res.json());
});

app.post("/api/cs/:sessionId/takeover", async (c) => {
  const sessionId = c.req.param("sessionId");
  const stub = getDO(c.env, sessionId);
  const res = await stub.fetch(`https://do/takeover?sessionId=${encodeURIComponent(sessionId)}`, { method: "POST" });
  return c.json(await res.json());
});

app.post("/api/cs/:sessionId/release", async (c) => {
  const sessionId = c.req.param("sessionId");
  const stub = getDO(c.env, sessionId);
  const res = await stub.fetch(`https://do/release?sessionId=${encodeURIComponent(sessionId)}`, { method: "POST" });
  return c.json(await res.json());
});

app.post("/api/cs/:sessionId/reply", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{ text: string }>();
  const stub = getDO(c.env, sessionId);
  const res = await stub.fetch(`https://do/cs-reply?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    body: JSON.stringify({ text: body.text }),
    headers: { "content-type": "application/json" },
  });
  return c.json(await res.json());
});

// Antrean CS: sesi mode HUMAN diurutkan dari yang menunggu paling lama (handoff_at), dengan SLA
// respons (lihat ChatSession RESPONSE_SLA_MINUTES) agar konsol bisa menyorot yang sudah lewat tenggat.
app.get("/api/cs/queue", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT session_id, persona, mode, verified_actor_id, last_message, last_sender, handoff_at, sla_due_at, handoff_summary, updated_at
     FROM sessions_index WHERE mode = 'HUMAN' ORDER BY handoff_at ASC`,
  ).all();
  return c.json(rows.results);
});

app.get("/api/cs/sessions", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT * FROM sessions_index ORDER BY updated_at DESC LIMIT 50`).all();
  return c.json(rows.results);
});

app.get("/api/audit/:sessionId/verify", async (c) => {
  const sessionId = c.req.param("sessionId");
  const stub = getDO(c.env, sessionId);
  const res = await stub.fetch(`https://do/audit-verify?sessionId=${encodeURIComponent(sessionId)}`);
  return c.json(await res.json());
});

app.get("/api/audit/:sessionId/log", async (c) => {
  const sessionId = c.req.param("sessionId");
  const rows = await c.env.DB.prepare(`SELECT seq, actor, event_type, payload, hash, created_at FROM audit_log WHERE session_id = ? ORDER BY seq ASC`).bind(sessionId).all();
  return c.json(rows.results);
});

app.get("/api/kpi", async (c) => {
  const [tickets, dsr, logCount] = await Promise.all([
    c.env.DB.prepare(`SELECT status, COUNT(*) as n FROM tickets GROUP BY status`).all(),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM dsr_requests`).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT session_id) as n FROM audit_log`).first<{ n: number }>(),
  ]);
  const sessions = await c.env.DB.prepare(`SELECT mode, COUNT(*) as n FROM sessions_index GROUP BY mode`).all();
  const personas = await c.env.DB.prepare(`SELECT persona, COUNT(*) as n FROM sessions_index GROUP BY persona`).all();
  return c.json({ tickets: tickets.results, dsr_total: dsr?.n ?? 0, sessions_total: logCount?.n ?? 0, sessions_by_mode: sessions.results, sessions_by_persona: personas.results });
});

app.get("/api/health", (c) => c.json({ ok: true, env: "demo" }));

// Ingest KB ke Vectorize. Dipanggil sekali (atau tiap KB berubah) oleh scripts/run-ingest.ts,
// bukan jalur produksi pengguna -> dilindungi header x-admin-key (wrangler secret ADMIN_KEY).
app.post("/api/admin/ingest", async (c) => {
  const key = c.req.header("x-admin-key");
  if (!c.env.ADMIN_KEY || key !== c.env.ADMIN_KEY) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req.json<{ chunks: { chunk_ref: string; doc_id: string; text: string; needs_verification: boolean; source_type: string }[] }>();
  let inserted = 0;
  for (const chunk of body.chunks) {
    const embedRes: any = await c.env.AI.run(c.env.EMBED_MODEL as any, { text: [chunk.text] });
    const vector: number[] = embedRes?.data?.[0] ?? embedRes?.[0];
    if (!vector) continue;
    await c.env.VECTORIZE.upsert([
      {
        id: chunk.chunk_ref,
        values: vector,
        metadata: { doc_id: chunk.doc_id, chunk_ref: chunk.chunk_ref, text: chunk.text, needs_verification: chunk.needs_verification, source_type: chunk.source_type },
      },
    ]);
    inserted += 1;
  }
  return c.json({ ok: true, inserted });
});

// Fallback: serve static UI (React SPA) untuk semua rute non-/api.
app.notFound(async (c) => {
  const assetRes = await c.env.ASSETS.fetch(c.req.raw);
  if (assetRes.status !== 404) return assetRes;
  const indexReq = new Request(new URL("/index.html", c.req.url), c.req.raw);
  return c.env.ASSETS.fetch(indexReq);
});

export default app;

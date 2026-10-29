import { Hono } from "hono";
import { ChatAgent } from "./do/ChatAgent";
import { signPresenterToken, verifyPresenterToken, readCookie, presenterCookieHeader, clearPresenterCookieHeader } from "./security/presenter";
import { checkIpRateLimit } from "./security/rateLimit";
import { extrasApp, type ExtrasAppEnv } from "./extras/router";
import { PRESENTER_QA } from "./data/presenterQa";

export { ChatAgent };
export { SlaEscalationWorkflow } from "./extras/workflows/slaEscalationWorkflow";

export interface Env extends ExtrasAppEnv {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  CHAT_AGENT: DurableObjectNamespace;
  ASSETS: Fetcher;
  MODEL_PRIMARY: string;
  MODEL_GUARD: string;
  EMBED_MODEL: string;
  ADMIN_KEY?: string;
  CS_TOKEN?: string;
  PRESENTER_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  KENARI_API_KEY?: string;
  AUDIT_HMAC_KEY?: string;
}

const app = new Hono<{ Bindings: Env; Variables: { csFull: boolean } }>();

// Mode Publik vs Presenter (visibility-rules.md, WAJIB) — cookie HttpOnly bertanda, bukan
// passphrase mentah (lihat security/presenter.ts). `isPresenter` dipakai untuk (a) membebaskan
// rate limit publik di bawah, (b) /api/presenter/status yang dibaca frontend untuk
// menyembunyikan/menampilkan panel admin, link Langfuse, dll, (c) bypass x-cs-token/x-admin-key
// di bawah supaya Bagus (presenter) tidak perlu mengetik ulang secret di browser.
async function isPresenter(c: any): Promise<boolean> {
  const token = readCookie(c.req.header("cookie"), "mmk_presenter");
  return verifyPresenterToken(c.env.PRESENTER_KEY, token);
}

// FIX (P0 "banyak freezing dan button error"): token Konsol CS SEBELUMNYA diminta via
// window.prompt() dan harus = wrangler secret CS_TOKEN asli — pengunjung publik jelas tidak
// punya nilainya, jadi prompt tampil berulang (terasa seperti freeze, dialog blocking) dan setiap
// panggilan API balik 401 (token langsung dihapus, UI terasa "semua tombol error"). Sesuai
// visibility-rules.md ("Konsol CS ... mode demo, token demo bawaan"): token publik yang SENGAJA
// tidak rahasia (bukan secret asli, data yang dilindungi tetap sintetis) dipakai otomatis tanpa
// prompt untuk akses BACA; aksi yang mengubah data (takeover/release/balas CS/approve/reject HITL)
// tetap mewajibkan mode Presenter ATAU CS_TOKEN asli (lihat requireFullCs di bawah).
const PUBLIC_DEMO_CS_TOKEN = "demo-mitra-cs-2026";

async function requireCsToken(c: any, next: () => Promise<void>) {
  const token = c.req.header("x-cs-token") ?? c.req.query("token");
  const full = (await isPresenter(c)) || (!!c.env.CS_TOKEN && token === c.env.CS_TOKEN);
  const demo = token === PUBLIC_DEMO_CS_TOKEN;
  if (!full && !demo) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("csFull", full);
  await next();
}
app.use("/api/cs/*", requireCsToken);
app.use("/api/audit/*", requireCsToken);
app.use("/api/chat/:sessionId/history", requireCsToken);

/** Aksi yang mengubah data (bukan sekadar lihat) — hanya Presenter atau pemegang CS_TOKEN asli. */
function requireFullCs(c: any) {
  if (!c.get("csFull")) return c.json({ error: "Aksi ini khusus mode Presenter." }, 403);
  return null;
}

// FIX P0 (temuan QA #4): Konsol CS publik SEBELUMNYA menampilkan "Semua sesi" (SEMUA percakapan
// pengunjung lain) + queue (termasuk sesi eval/test) ke SIAPA PUN yang punya token demo publik
// (PUBLIC_DEMO_CS_TOKEN, sengaja tidak rahasia). Sekarang: pengunjung publik (!csFull) HANYA boleh
// melihat sesinya SENDIRI (dibuktikan lewat query `?mine=<sessionId>` yang dikirim client dari
// sessionStorage, sama seperti sessionId chat-nya sendiri — lihat ui/src/App.tsx), ditegakkan DI
// SERVER (bukan hanya disembunyikan di UI). Mode Presenter/CS_TOKEN asli tetap bisa lihat semua.
function ownSessionFilter(c: any, sessionIdColumn = "session_id"): { sql: string; param: string } | null {
  if (c.get("csFull")) return null; // tidak ada filter -> boleh lihat semua
  const mine = String(c.req.query("mine") ?? "");
  if (!mine) return { sql: `${sessionIdColumn} = ?`, param: "__no_session_provided__" };
  return { sql: `${sessionIdColumn} = ?`, param: mine };
}

/** x-admin-key ATAU cookie Presenter — dipakai panel kill-switch & demo-tamper (keduanya sudah
 * presenter-only di UI). /api/admin/ingest TIDAK memakai ini — tetap wajib ADMIN_KEY asli karena
 * dipanggil dari script (scripts/run-ingest.ts), bukan browser. */
async function requireAdminOrPresenter(c: any): Promise<boolean> {
  if (await isPresenter(c)) return true;
  const key = c.req.header("x-admin-key");
  return !!c.env.ADMIN_KEY && key === c.env.ADMIN_KEY;
}

app.post("/api/presenter/login", async (c) => {
  const body = await c.req.json<{ key: string }>().catch(() => ({ key: "" }));
  if (!c.env.PRESENTER_KEY || body.key !== c.env.PRESENTER_KEY) {
    return c.json({ ok: false }, 401);
  }
  const token = await signPresenterToken(c.env.PRESENTER_KEY);
  const secure = new URL(c.req.url).protocol === "https:";
  c.header("set-cookie", presenterCookieHeader(token, secure));
  return c.json({ ok: true });
});

app.post("/api/presenter/logout", async (c) => {
  const secure = new URL(c.req.url).protocol === "https:";
  c.header("set-cookie", clearPresenterCookieHeader(secure));
  return c.json({ ok: true });
});

app.get("/api/presenter/status", async (c) => {
  return c.json({ presenter: await isPresenter(c) });
});

// Q&A interview /learn (visibility-rules.md: ❌ publik, ✅ presenter) — SENGAJA hidup di server
// (src/data/presenterQa.ts), tidak pernah di client bundle. Temuan QA: sebelumnya 13 pasang Q&A
// ikut ter-bundle ke JS publik (hanya disembunyikan di UI, tetap terbaca via view-source).
app.get("/api/presenter/qa", async (c) => {
  if (!(await isPresenter(c))) return c.json({ error: "unauthorized" }, 401);
  return c.json(PRESENTER_QA);
});

// Rate limit kasar per-IP untuk pengunjung publik (bukan presenter) pada jalur yang memanggil
// LLM/embedding (Kenari/Workers AI) — lindungi kuota setelah demo dibagikan ke pewawancara.
async function publicRateLimit(c: any, next: () => Promise<void>) {
  if (await isPresenter(c)) return next();
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { ok } = await checkIpRateLimit(c.env.DB, ip, "chat", 40);
  if (!ok) {
    return c.json({ error: "Terlalu banyak permintaan dari alamat ini, coba lagi beberapa menit lagi (demo publik dibatasi untuk menjaga kuota)." }, 429);
  }
  await next();
}
app.use("/api/chat/:sessionId/ws", publicRateLimit);
app.use("/api/chat/:sessionId/message", publicRateLimit);

function getDO(env: Env, sessionId: string) {
  const id = env.CHAT_AGENT.idFromName(sessionId);
  return env.CHAT_AGENT.get(id);
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

// FIX (temuan QA MAJOR c): useAgentChat (client) fetch GET .../ws/get-messages saat mount/refresh
// untuk memulihkan histori pesan — rute ini sebelumnya TIDAK terdaftar di Worker, jadi jatuh ke
// app.notFound() -> SPA fallback -> balas index.html (200 OK) -> client gagal parse JSON
// ("Failed to parse initial messages JSON") -> chat kelihatan kosong setelah refresh. Diteruskan
// ke DO (AIChatAgent bawaan sudah menangani path yang diakhiri "/get-messages", sama seperti "/ws").
app.get("/api/chat/:sessionId/ws/get-messages", async (c) => {
  const sessionId = c.req.param("sessionId");
  const stub = getDO(c.env, sessionId);
  return forwardToDO(stub, c.req.raw, "/get-messages", { sessionId });
});

app.get("/api/cs/:sessionId/ws", async (c) => {
  // Kanal observer+takeover CS. requireCsToken (di atas, terpasang di /api/cs/*) sudah menerima
  // token demo publik untuk BACA; di sini kirim peran "cs-demo" bila bukan csFull supaya DO bisa
  // menolak takeover/release/cs_message dari koneksi demo (lihat ChatAgent.ts) -> publik tetap bisa
  // mengamati percakapan live tapi tidak bisa mengambil alih/membalas sebagai CS.
  const sessionId = c.req.param("sessionId");
  const stub = getDO(c.env, sessionId);
  const role = c.get("csFull") ? "cs" : "cs-demo";
  return forwardToDO(stub, c.req.raw, "/ws", { sessionId, role });
});

app.post("/api/chat/:sessionId/message", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{ text: string; persona?: string; isEvalRun?: boolean }>();
  if (!body?.text || typeof body.text !== "string" || body.text.length > 2000) {
    return c.json({ error: "text wajib diisi, maksimal 2000 karakter" }, 400);
  }
  const persona = body.persona === "pendana" || body.persona === "petugas" ? body.persona : "mitra";

  const stub = getDO(c.env, sessionId);
  // `isEvalRun` (dikirim scripts/run-eval.ts, run-langfuse-eval.ts, run-extras-eval.ts,
  // measure-latency.ts -- lihat header x-eval-run di bawah) -> ditandai `source='eval'` di
  // sessions_index (ChatAgent.syncSessionsIndex) supaya TIDAK PERNAH muncul di antrean CS live
  // (lihat /api/cs/queue, /api/cs/sessions) -- temuan QA #4: 42 sesi eval mencemari antrean live.
  const isEvalRun = !!body.isEvalRun || c.req.header("x-eval-run") === "1";
  const res = await stub.fetch(`https://do/message?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    body: JSON.stringify({ text: body.text, persona, isEvalRun }),
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
  const denied = requireFullCs(c);
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const stub = getDO(c.env, sessionId);
  const res = await stub.fetch(`https://do/takeover?sessionId=${encodeURIComponent(sessionId)}`, { method: "POST" });
  return c.json(await res.json());
});

app.post("/api/cs/:sessionId/release", async (c) => {
  const denied = requireFullCs(c);
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const stub = getDO(c.env, sessionId);
  const res = await stub.fetch(`https://do/release?sessionId=${encodeURIComponent(sessionId)}`, { method: "POST" });
  return c.json(await res.json());
});

app.post("/api/cs/:sessionId/reply", async (c) => {
  const denied = requireFullCs(c);
  if (denied) return denied;
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
// `source != 'eval'` (lihat migrasi kolom `source` di schema.sql): sesi dari scripts/run-eval.ts dkk
// TIDAK PERNAH ikut muncul di antrean live, publik maupun Presenter (temuan QA: 42 sesi eval dengan
// "SLA lewat 464m" ikut nongol di antrean live).
app.get("/api/cs/queue", async (c) => {
  const own = ownSessionFilter(c);
  const rows = await c.env.DB.prepare(
    `SELECT session_id, persona, mode, verified_actor_id, last_message, last_sender, handoff_at, sla_due_at, handoff_summary, updated_at
     FROM sessions_index WHERE mode = 'HUMAN' AND (source IS NULL OR source != 'eval') ${own ? `AND ${own.sql}` : ""} ORDER BY handoff_at ASC`,
  )
    .bind(...(own ? [own.param] : []))
    .all();
  return c.json(rows.results);
});

// "Semua sesi" — PRESENTER/CS_TOKEN ASLI SAJA (server-enforced, bukan hanya disembunyikan di UI).
// Publik hanya melihat sesinya sendiri (1 baris, lewat ?mine=, atau kosong kalau tidak dikirim).
app.get("/api/cs/sessions", async (c) => {
  const own = ownSessionFilter(c);
  const rows = await c.env.DB.prepare(
    `SELECT * FROM sessions_index WHERE (source IS NULL OR source != 'eval') ${own ? `AND ${own.sql}` : ""} ORDER BY updated_at DESC LIMIT 50`,
  )
    .bind(...(own ? [own.param] : []))
    .all();
  return c.json(rows.results);
});

// HITL four-eyes (integritas data §Security): restrukturisasi/keringanan dicatat AI sebagai
// 'pending_cs_approval' (src/tools/execute.ts) — HARUS disetujui/ditolak CS di sini sebelum
// berstatus 'submitted' dan diteruskan ke petugas lapangan/tim kredit.
// `approved_once` ditambahkan di antara pending_cs_approval -> submitted (lihat fix four-eyes di
// bawah) -- tetap tampil di daftar "menunggu" sampai approver KEDUA yang BERBEDA menyetujui.
app.get("/api/cs/hitl/pending", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT restru_id, mitra_id, pinjaman_no, reason, status, first_approver, created_at FROM restructuring_requests WHERE status IN ('pending_cs_approval', 'approved_once') ORDER BY created_at ASC`,
  ).all();
  return c.json(rows.results);
});

// FIX (temuan QA MAJOR d — "four-eyes palsu"): SEBELUMNYA satu klik "Setujui" langsung membuat
// status 'submitted' (hanya 1 approver), dan approve KEDUA oleh ORANG YANG SAMA tetap balas 200
// (bukan ditolak) -- jadi "four-eyes" cuma nama, bukan kontrol sungguhan. Sekarang: approve
// PERTAMA -> 'approved_once' (mencatat `first_approver`); approve KEDUA WAJIB nama approver BEDA
// (case-insensitive, trim) baru jadi 'submitted'; approver yang SAMA mencoba approve lagi -> 409
// dengan pesan jelas (bukan diam-diam sukses).
app.post("/api/cs/hitl/:restruId/approve", async (c) => {
  const denied = requireFullCs(c);
  if (denied) return denied;
  const restruId = c.req.param("restruId");
  const body = await c.req.json<{ approver?: string }>().catch(() => ({}) as { approver?: string });
  const approver = (body.approver ?? "").trim();
  if (!approver) return c.json({ error: "Nama approver wajib diisi (four-eyes butuh identitas approver)." }, 400);

  const row = await c.env.DB.prepare(`SELECT status, first_approver FROM restructuring_requests WHERE restru_id = ?`).bind(restruId).first<{ status: string; first_approver: string | null }>();
  if (!row) return c.json({ error: "Permintaan tidak ditemukan." }, 404);

  if (row.status === "pending_cs_approval") {
    await c.env.DB.prepare(`UPDATE restructuring_requests SET status = 'approved_once', first_approver = ? WHERE restru_id = ? AND status = 'pending_cs_approval'`).bind(approver, restruId).run();
    await c.env.DB.prepare(`INSERT INTO record_versions (record_type, record_id, status, changed_by, note) VALUES ('restructuring_request', ?, 'approved_once', 'cs', ?)`).bind(restruId, `approver 1: ${approver}`).run();
    return c.json({ ok: true, status: "approved_once", note: "Approve pertama tercatat. Menunggu approver KEDUA yang berbeda untuk finalisasi (four-eyes)." });
  }

  if (row.status === "approved_once") {
    if (row.first_approver && row.first_approver.trim().toLowerCase() === approver.toLowerCase()) {
      return c.json({ error: `Approver kedua harus BERBEDA dari approver pertama (${row.first_approver}) — four-eyes butuh 2 orang berbeda.` }, 409);
    }
    await c.env.DB.prepare(`UPDATE restructuring_requests SET status = 'submitted' WHERE restru_id = ? AND status = 'approved_once'`).bind(restruId).run();
    await c.env.DB.prepare(`INSERT INTO record_versions (record_type, record_id, status, changed_by, note) VALUES ('restructuring_request', ?, 'submitted', 'cs', ?)`).bind(restruId, `approver 2: ${approver} (approver 1: ${row.first_approver})`).run();
    return c.json({ ok: true, status: "submitted" });
  }

  return c.json({ error: `Permintaan ini sudah berstatus '${row.status}', tidak bisa di-approve lagi.` }, 409);
});

app.post("/api/cs/hitl/:restruId/reject", async (c) => {
  const denied = requireFullCs(c);
  if (denied) return denied;
  const restruId = c.req.param("restruId");
  const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
  await c.env.DB.prepare(`UPDATE restructuring_requests SET status = 'rejected' WHERE restru_id = ? AND status IN ('pending_cs_approval', 'approved_once')`).bind(restruId).run();
  await c.env.DB.prepare(`INSERT INTO record_versions (record_type, record_id, status, changed_by, note) VALUES ('restructuring_request', ?, 'rejected', 'cs', ?)`).bind(restruId, body.note ?? null).run();
  return c.json({ ok: true, status: "rejected" });
});

// FIX (temuan QA #g): audit log/verify sebelumnya bisa diakses untuk SESI SIAPA PUN memakai token
// demo publik (hanya butuh tahu session_id, tanpa ada pengecekan "ini sesi Anda sendiri?") — jadi
// publik bisa membaca trace PII-redacted milik pengunjung lain. Sekarang: bukan Presenter/CS_TOKEN
// asli -> wajib ?mine=<sessionId milik sendiri> yang SAMA dengan :sessionId di path.
function requireOwnSessionOrFull(c: any, sessionId: string): Response | null {
  if (c.get("csFull")) return null;
  const mine = String(c.req.query("mine") ?? "");
  if (!mine || mine !== sessionId) return c.json({ error: "Audit log sesi lain khusus mode Presenter." }, 403);
  return null;
}

app.get("/api/audit/:sessionId/verify", async (c) => {
  const sessionId = c.req.param("sessionId");
  const denied = requireOwnSessionOrFull(c, sessionId);
  if (denied) return denied;
  const stub = getDO(c.env, sessionId);
  const res = await stub.fetch(`https://do/audit-verify?sessionId=${encodeURIComponent(sessionId)}`);
  return c.json(await res.json());
});

app.get("/api/audit/:sessionId/log", async (c) => {
  const sessionId = c.req.param("sessionId");
  const denied = requireOwnSessionOrFull(c, sessionId);
  if (denied) return denied;
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

// feat/extras — satu titik integrasi untuk voice/STT-TTS, bahasa, semantic cache+routing, SLA
// Workflows, memori jangka panjang, dan Langfuse prompt-mgmt/online-eval (lihat src/extras/router.ts).
// Modul mandiri: tiap route mengecek feature flag-nya sendiri (FEATURE_* di wrangler.toml [vars]),
// aman dipasang walau sebagian fitur masih OFF.
app.route("/api/extras", extrasApp);

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

// Kill-switch per tool (integritas data §Security) — mode Presenter-only di UI, tapi tetap
// dilindungi x-admin-key (BUKAN CS_TOKEN) seperti endpoint admin lain.
app.post("/api/admin/kill-switch/:toolName", async (c) => {
  if (!(await requireAdminOrPresenter(c))) return c.json({ error: "unauthorized" }, 401);
  const toolName = c.req.param("toolName");
  const body = await c.req.json<{ disabled: boolean; reason?: string }>();
  await c.env.DB.prepare(
    `INSERT INTO tool_kill_switch (tool_name, disabled, reason, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(tool_name) DO UPDATE SET disabled = excluded.disabled, reason = excluded.reason, updated_at = datetime('now')`,
  )
    .bind(toolName, body.disabled ? 1 : 0, body.reason ?? null)
    .run();
  return c.json({ ok: true, toolName, disabled: body.disabled });
});

app.get("/api/admin/kill-switch", async (c) => {
  if (!(await requireAdminOrPresenter(c))) return c.json({ error: "unauthorized" }, 401);
  const rows = await c.env.DB.prepare(`SELECT tool_name, disabled, reason, updated_at FROM tool_kill_switch`).all();
  return c.json(rows.results);
});

// Demo tamper (HANYA untuk mendemonstrasikan "Verifikasi integritas log" mendeteksi perubahan —
// lihat README §Security): mengubah SATU baris audit_log TANPA lewat appendAuditLog (jadi hash
// HMAC-nya tidak dihitung ulang) -> verifyChain() akan melaporkan RUSAK mulai dari baris itu.
// Hanya menyentuh kolom `payload`, dilindungi x-admin-key, data sintetis semata.
app.post("/api/admin/tamper-demo/:sessionId", async (c) => {
  if (!(await requireAdminOrPresenter(c))) return c.json({ error: "unauthorized" }, 401);
  const sessionId = c.req.param("sessionId");
  const row = await c.env.DB.prepare(`SELECT seq FROM audit_log WHERE session_id = ? ORDER BY seq ASC LIMIT 1`).bind(sessionId).first<{ seq: number }>();
  if (!row) return c.json({ error: "sesi tidak punya audit log" }, 404);
  await c.env.DB.prepare(`UPDATE audit_log SET payload = ? WHERE session_id = ? AND seq = ?`)
    .bind(JSON.stringify({ tampered_for_demo: true, at: new Date().toISOString() }), sessionId, row.seq)
    .run();
  return c.json({ ok: true, tamperedSeq: row.seq, note: "Klik 'Verifikasi integritas log' sekarang — harus melaporkan rusak mulai baris ini." });
});

// Fallback: serve static UI (React SPA) untuk semua rute non-/api.
app.notFound(async (c) => {
  const assetRes = await c.env.ASSETS.fetch(c.req.raw);
  if (assetRes.status !== 404) return assetRes;
  const indexReq = new Request(new URL("/index.html", c.req.url), c.req.raw);
  return c.env.ASSETS.fetch(indexReq);
});

export default app;

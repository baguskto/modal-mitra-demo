import { runAgentTurn, type AgentEnvBindings } from "../agent/toolAgent";
import { callChatModel } from "../agent/llm";
import { appendAuditLog, verifyChain } from "../obs/audit";
import type { Persona } from "../agent/router";

export interface ChatSessionEnv extends AgentEnvBindings {
  DB: D1Database;
}

interface HistoryItem {
  role: "user" | "ai" | "human" | "system";
  text: string;
  citations?: string[];
  ts: string;
}

interface SessionState {
  persona: Persona;
  mode: "AI" | "HUMAN";
  verifiedActorId: string | null;
  failedUnderstandingCount: number;
  history: HistoryItem[];
  handoffSummary: string | null;
  handoffAt: string | null;
}

const MAX_HISTORY = 60;
const RESPONSE_SLA_MINUTES = 5; // target CS merespons setelah handoff (demo; bukan SLA tiket pengaduan POJK)

// Durable Object per percakapan: menyimpan state verifikasi + mode (AI/HUMAN) + persona secara
// konsisten, satu-threaded per sessionId (menghindari race condition CS & AI membalas bersamaan),
// DAN jadi hub WebSocket real-time (Hibernation API) untuk streaming token + multi-klien + handoff live.
export class ChatSession {
  state: DurableObjectState;
  env: ChatSessionEnv;

  constructor(state: DurableObjectState, env: ChatSessionEnv) {
    this.state = state;
    this.env = env;
  }

  private async getSession(): Promise<SessionState> {
    const stored = await this.state.storage.get<SessionState>("session");
    return stored ?? { persona: "mitra", mode: "AI", verifiedActorId: null, failedUnderstandingCount: 0, history: [], handoffSummary: null, handoffAt: null };
  }

  private async saveSession(s: SessionState) {
    s.history = s.history.slice(-MAX_HISTORY);
    await this.state.storage.put("session", s);
  }

  private broadcast(payload: Record<string, any>, filterRole?: "customer" | "cs") {
    const json = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      const attach = safeDeserialize(ws);
      if (filterRole && attach?.role !== filterRole) continue;
      try {
        ws.send(json);
      } catch {
        // socket mungkin sudah tertutup di sisi klien, aman untuk diabaikan
      }
    }
  }

  private async syncSessionsIndex(sessionId: string, s: SessionState, lastMessage: string, lastSender: string) {
    await this.env.DB.prepare(
      `INSERT INTO sessions_index (session_id, persona, mode, verified_actor_id, last_message, last_sender, handoff_at, sla_due_at, handoff_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET persona=excluded.persona, mode=excluded.mode, verified_actor_id=excluded.verified_actor_id,
         last_message=excluded.last_message, last_sender=excluded.last_sender, handoff_at=excluded.handoff_at,
         sla_due_at=excluded.sla_due_at, handoff_summary=excluded.handoff_summary, updated_at=datetime('now')`,
    )
      .bind(
        sessionId,
        s.persona,
        s.mode,
        s.verifiedActorId,
        lastMessage.slice(0, 200),
        lastSender,
        s.handoffAt,
        s.handoffAt ? new Date(new Date(s.handoffAt).getTime() + RESPONSE_SLA_MINUTES * 60_000).toISOString() : null,
        s.handoffSummary,
      )
      .run();
  }

  private async summarizeForHandoff(history: HistoryItem[]): Promise<string> {
    const transcript = history.slice(-10).map((h) => `${h.role}: ${h.text}`).join("\n").slice(0, 3000);
    try {
      const res = await callChatModel(
        this.env.AI,
        this.env.MODEL_PRIMARY,
        [
          { role: "system", content: "Ringkas percakapan berikut dalam 1-2 kalimat Bahasa Indonesia untuk CS yang akan mengambil alih. Sebutkan isu utama & urgensinya. Balas HANYA ringkasan teks biasa, tanpa JSON/markdown." },
          { role: "user", content: transcript },
        ],
        { max_tokens: 150, temperature: 0.2 },
      );
      return res.text?.trim() || "Ringkasan otomatis tidak tersedia, mohon baca transkrip.";
    } catch {
      return "Ringkasan otomatis tidak tersedia, mohon baca transkrip.";
    }
  }

  /** Inti pemrosesan 1 pesan pengguna — dipakai BERSAMA oleh jalur WebSocket (streaming) dan HTTP legacy (non-streaming, dipakai eval). */
  private async processUserMessage(sessionId: string, text: string, personaHint: Persona | undefined, streamToken: (t: string) => void) {
    const session = await this.getSession();
    if (personaHint && session.history.length === 0) session.persona = personaHint; // persona dikunci di pesan pertama sesi

    const userTs = new Date().toISOString();
    session.history.push({ role: "user", text, ts: userTs });
    // Broadcast ke SEMUA klien tersambung (tab lain pengguna yang sama + konsol CS yang sedang
    // observe) agar sesi multi-pengguna/multi-tab benar-benar real-time, bukan hanya optimistic
    // update lokal di pengirim.
    this.broadcast({ type: "message", role: "user", text, ts: userTs });

    if (session.mode === "HUMAN") {
      await this.saveSession(session);
      await this.syncSessionsIndex(sessionId, session, text, "user");
      const reply = "Percakapan ini sedang ditangani CS kami. Mohon tunggu balasan dari CS.";
      this.broadcast({ type: "message", role: "ai", text: reply, ts: new Date().toISOString() });
      return { reply, mode: session.mode, verifiedActorId: session.verifiedActorId, persona: session.persona };
    }

    this.broadcast({ type: "ai_typing_start" });
    let streamedAny = false;
    const result = await runAgentTurn(
      this.env,
      {
        sessionId,
        persona: session.persona,
        userText: text,
        verifiedActorId: session.verifiedActorId,
        failedUnderstandingCount: session.failedUnderstandingCount,
      },
      (token) => {
        streamedAny = true;
        streamToken(token);
      },
    );
    if (!streamedAny) streamToken(""); // no-op guard path tidak mengalirkan token, UI tetap dapat ai_typing_end via message final

    session.verifiedActorId = result.verifiedActorId;
    session.history.push({ role: "ai", text: result.answerText, citations: result.citations, ts: new Date().toISOString() });

    if (result.handoff.triggered) {
      session.mode = "HUMAN";
      session.handoffAt = new Date().toISOString();
      session.handoffSummary = await this.summarizeForHandoff(session.history);
      await appendAuditLog(this.env.DB, sessionId, "system", "mode_change", { mode: "HUMAN", reason: result.handoff.reason });
    }
    if (result.blockedByGuard) {
      session.failedUnderstandingCount += 1;
    } else {
      session.failedUnderstandingCount = 0;
    }
    await this.saveSession(session);
    await this.syncSessionsIndex(sessionId, session, result.answerText, "ai");

    this.broadcast({ type: "ai_typing_end" });
    // retracted: jawaban SUDAH mengalir token-by-token sebelum guard output selesai divalidasi
    // (trade-off desain demo untuk UX streaming nyata) -> jika guard memblokir, kirim event retracted
    // agar klien MENGGANTI bubble yang sudah tampil dengan versi aman, bukan menambah bubble baru.
    this.broadcast({
      type: result.blockedByGuard ? "retracted" : "message",
      role: "ai",
      text: result.answerText,
      citations: result.citations,
      intent: result.intent,
      blockedByGuard: result.blockedByGuard,
      timing: result.timing,
      ts: new Date().toISOString(),
    });
    if (result.handoff.triggered) {
      this.broadcast({ type: "mode_change", mode: "HUMAN", reason: result.handoff.reason, severity: result.handoff.severity, summary: session.handoffSummary });
    }

    return {
      reply: result.answerText,
      citations: result.citations,
      intent: result.intent,
      mode: session.mode,
      verifiedActorId: session.verifiedActorId,
      persona: session.persona,
      toolCallsMade: result.toolCallsMade,
      modelUsed: result.modelUsed,
      blockedByGuard: result.blockedByGuard,
      timing: result.timing,
    };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const sessionId = safeDeserialize(ws)?.sessionId ?? "unknown";
    const role = safeDeserialize(ws)?.role ?? "customer";
    let msg: any;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (msg.type === "user_message" && role === "customer" && typeof msg.text === "string" && msg.text.length > 0 && msg.text.length <= 2000) {
      await this.processUserMessage(sessionId, msg.text, msg.persona, (token) => this.broadcast({ type: "token", text: token }));
      return;
    }

    if (msg.type === "cs_message" && role === "cs" && typeof msg.text === "string") {
      const session = await this.getSession();
      session.history.push({ role: "human", text: msg.text, ts: new Date().toISOString() });
      await this.saveSession(session);
      await this.syncSessionsIndex(sessionId, session, msg.text, "human");
      await appendAuditLog(this.env.DB, sessionId, "human", "cs_reply", { text_len: msg.text.length });
      this.broadcast({ type: "message", role: "human", text: msg.text, ts: new Date().toISOString() });
      return;
    }

    if (msg.type === "takeover" && role === "cs") {
      const session = await this.getSession();
      session.mode = "HUMAN";
      session.handoffAt = session.handoffAt ?? new Date().toISOString();
      await this.saveSession(session);
      await this.syncSessionsIndex(sessionId, session, "(CS mengambil alih)", "human");
      await appendAuditLog(this.env.DB, sessionId, "human", "mode_change", { mode: "HUMAN", reason: "cs_takeover" });
      this.broadcast({ type: "mode_change", mode: "HUMAN", reason: "cs_takeover" });
      return;
    }

    if (msg.type === "release" && role === "cs") {
      const session = await this.getSession();
      session.mode = "AI";
      session.handoffAt = null;
      session.handoffSummary = null;
      await this.saveSession(session);
      await this.syncSessionsIndex(sessionId, session, "(CS mengembalikan ke AI)", "human");
      await appendAuditLog(this.env.DB, sessionId, "human", "mode_change", { mode: "AI", reason: "cs_release" });
      this.broadcast({ type: "mode_change", mode: "AI", reason: "cs_release" });
      return;
    }

    if (msg.type === "typing") {
      this.broadcast({ type: "typing", role, isTyping: !!msg.isTyping }, role === "customer" ? "cs" : "customer");
      return;
    }
  }

  async webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {
      // sudah tertutup
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId") ?? "unknown";

    if (url.pathname.endsWith("/ws")) {
      const role = (url.searchParams.get("role") === "cs" ? "cs" : "customer") as "cs" | "customer";
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ role, sessionId });

      const session = await this.getSession();
      try {
        server.send(
          JSON.stringify({
            type: "init",
            history: session.history,
            mode: session.mode,
            persona: session.persona,
            verifiedActorId: session.verifiedActorId,
            handoffSummary: session.handoffSummary,
            handoffAt: session.handoffAt,
            slaMinutes: RESPONSE_SLA_MINUTES,
          }),
        );
      } catch {
        // client mungkin sudah disconnect sesaat setelah connect
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/message") && request.method === "POST") {
      const body = await request.json<{ text: string; persona?: Persona }>();
      const data = await this.processUserMessage(sessionId, body.text, body.persona, () => {});
      return jsonResponse(data);
    }

    if (url.pathname.endsWith("/history") && request.method === "GET") {
      const session = await this.getSession();
      return jsonResponse(session);
    }

    if (url.pathname.endsWith("/takeover") && request.method === "POST") {
      const session = await this.getSession();
      session.mode = "HUMAN";
      session.handoffAt = session.handoffAt ?? new Date().toISOString();
      await this.saveSession(session);
      await this.syncSessionsIndex(sessionId, session, "(CS mengambil alih)", "human");
      await appendAuditLog(this.env.DB, sessionId, "human", "mode_change", { mode: "HUMAN", reason: "cs_takeover" });
      this.broadcast({ type: "mode_change", mode: "HUMAN", reason: "cs_takeover" });
      return jsonResponse({ ok: true, mode: "HUMAN" });
    }

    if (url.pathname.endsWith("/release") && request.method === "POST") {
      const session = await this.getSession();
      session.mode = "AI";
      session.handoffAt = null;
      session.handoffSummary = null;
      await this.saveSession(session);
      await this.syncSessionsIndex(sessionId, session, "(CS mengembalikan ke AI)", "human");
      await appendAuditLog(this.env.DB, sessionId, "human", "mode_change", { mode: "AI", reason: "cs_release" });
      this.broadcast({ type: "mode_change", mode: "AI", reason: "cs_release" });
      return jsonResponse({ ok: true, mode: "AI" });
    }

    if (url.pathname.endsWith("/cs-reply") && request.method === "POST") {
      const body = await request.json<{ text: string }>();
      const session = await this.getSession();
      session.history.push({ role: "human", text: body.text, ts: new Date().toISOString() });
      await this.saveSession(session);
      await this.syncSessionsIndex(sessionId, session, body.text, "human");
      await appendAuditLog(this.env.DB, sessionId, "human", "cs_reply", { text_len: body.text.length });
      this.broadcast({ type: "message", role: "human", text: body.text, ts: new Date().toISOString() });
      return jsonResponse({ ok: true });
    }

    if (url.pathname.endsWith("/audit-verify") && request.method === "GET") {
      const result = await verifyChain(this.env.DB, sessionId);
      return jsonResponse(result);
    }

    return new Response("Not found", { status: 404 });
  }
}

function safeDeserialize(ws: WebSocket): { role: "customer" | "cs"; sessionId: string } | null {
  try {
    return (ws as any).deserializeAttachment() ?? null;
  } catch {
    return null;
  }
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });
}

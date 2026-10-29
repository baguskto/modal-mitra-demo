// Durable Object per percakapan — migrasi dari ChatSession.ts (DurableObject manual, lihat tag git
// `v1-pre-agents-sdk`) ke Cloudflare Agents SDK `AIChatAgent` (@cloudflare/ai-chat): persistensi
// pesan otomatis (SQLite), resumable streaming bawaan, broadcast multi-klien bawaan.
//
// Dua kanal WebSocket ke DO yang SAMA (dibedakan query ?role=):
//  - role=customer -> protokol chat standar AIChatAgent (dipakai `useAgentChat` di React, lihat
//    ui/src/ChatPanel.tsx) -> ditangani `super.onMessage`/`onChatMessage` di bawah.
//  - role=cs       -> kanal observer + takeover/release milik Konsol CS, protokol JSON KUSTOM
//    (takeover/release/cs_message/typing) — BUKAN bagian protokol chat AIChatAgent, sengaja
//    dipertahankan sederhana (raw WebSocket) karena brief hanya meminta `useAgentChat` untuk sisi
//    pelanggan, bukan konsol CS internal.
//
// State non-chat (persona/mode AI|HUMAN/verifiedActorId/handoffSummary) disimpan via `this.setState()`
// bawaan Agent -> otomatis tersinkron+broadcast ke SEMUA koneksi (customer & cs) sebagai
// `cf_agent_state`, DITAMBAH broadcast event kustom `mode_change` agar Konsol CS (raw WS, bukan
// `useAgent`) tidak perlu paham protokol state Agent.
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import type { Connection, ConnectionContext, WSMessage } from "agents";

import { runAgentGraph, relayFinalText, type AgentEnvBindings } from "../agent/graph";
import { callChatModel } from "../agent/llm";
import { appendAuditLog, verifyChain, configureAuditHmac } from "../obs/audit";
import { startTrace, pseudonymize, type LangfuseConfig, type XrayEvent } from "../obs/langfuse";
import type { Persona } from "../agent/router";

export interface ChatAgentEnv extends AgentEnvBindings {
  DB: D1Database;
  CS_TOKEN?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  PRESENTER_KEY?: string;
  AUDIT_HMAC_KEY?: string;
}

interface SessionMeta {
  persona: Persona;
  mode: "AI" | "HUMAN";
  verifiedActorId: string | null;
  failedUnderstandingCount: number;
  handoffSummary: string | null;
  handoffAt: string | null;
}

const RESPONSE_SLA_MINUTES = 5;
const PSEUDO_SALT = "modal-mitra-demo-v2"; // salt hash satu arah untuk sessionId yang dikirim ke Langfuse — bukan sumber kebenaran apa pun, hanya menghindari PII mentah di trace.

function textOf(m: UIMessage): string {
  return (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
}
function roleOf(m: UIMessage): "user" | "ai" | "human" | "system" {
  if (m.role === "user") return "user";
  if (m.role === "system") return "system";
  return (m as any).metadata?.source === "human" ? "human" : "ai";
}
function tsOf(m: UIMessage): string {
  return (m as any).metadata?.createdAt ?? (m as any).createdAt ?? new Date().toISOString();
}
function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });
}
function instantTextStream(text: string) {
  return createUIMessageStream({
    execute: async ({ writer }) => {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
    },
  });
}

export class ChatAgent extends AIChatAgent<ChatAgentEnv, SessionMeta> {
  initialState: SessionMeta = {
    persona: "mitra",
    mode: "AI",
    verifiedActorId: null,
    failedUnderstandingCount: 0,
    handoffSummary: null,
    handoffAt: null,
  };

  onStart() {
    configureAuditHmac(this.env.AUDIT_HMAC_KEY);
  }

  private langfuseConfig(): LangfuseConfig | null {
    const { LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = this.env;
    if (!LANGFUSE_BASE_URL || !LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) return null;
    return { baseUrl: LANGFUSE_BASE_URL, publicKey: LANGFUSE_PUBLIC_KEY, secretKey: LANGFUSE_SECRET_KEY };
  }

  private async syncSessionsIndex(lastMessage: string, lastSender: string) {
    await this.env.DB.prepare(
      `INSERT INTO sessions_index (session_id, persona, mode, verified_actor_id, last_message, last_sender, handoff_at, sla_due_at, handoff_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET persona=excluded.persona, mode=excluded.mode, verified_actor_id=excluded.verified_actor_id,
         last_message=excluded.last_message, last_sender=excluded.last_sender, handoff_at=excluded.handoff_at,
         sla_due_at=excluded.sla_due_at, handoff_summary=excluded.handoff_summary, updated_at=datetime('now')`,
    )
      .bind(
        this.name,
        this.state.persona,
        this.state.mode,
        this.state.verifiedActorId,
        lastMessage.slice(0, 200),
        lastSender,
        this.state.handoffAt,
        this.state.handoffAt ? new Date(new Date(this.state.handoffAt).getTime() + RESPONSE_SLA_MINUTES * 60_000).toISOString() : null,
        this.state.handoffSummary,
      )
      .run();
  }

  private async summarizeForHandoff(): Promise<string> {
    const transcript = this.messages
      .slice(-10)
      .map((m) => `${roleOf(m)}: ${textOf(m)}`)
      .join("\n")
      .slice(0, 3000);
    try {
      const res = await callChatModel(
        this.env.AI,
        this.env.MODEL_PRIMARY,
        [
          { role: "system", content: "Ringkas percakapan berikut dalam 1-2 kalimat Bahasa Indonesia untuk CS yang akan mengambil alih. Sebutkan isu utama & urgensinya. Balas HANYA ringkasan teks biasa, tanpa JSON/markdown." },
          { role: "user", content: transcript },
        ],
        { max_tokens: 150, temperature: 0.2 },
        this.env.KENARI_API_KEY,
      );
      return res.text?.trim() || "Ringkasan otomatis tidak tersedia, mohon baca transkrip.";
    } catch {
      return "Ringkasan otomatis tidak tersedia, mohon baca transkrip.";
    }
  }

  async getConnectionTags(connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    const base = (await (super.getConnectionTags as any)?.(connection, ctx)) ?? [];
    const url = new URL(ctx.request.url);
    const role = url.searchParams.get("role") === "cs" ? "cs" : "customer";
    return [...base, role];
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const role = url.searchParams.get("role") === "cs" ? "cs" : "customer";
    if (role === "cs") {
      const token = url.searchParams.get("token");
      if (!this.env.CS_TOKEN || token !== this.env.CS_TOKEN) {
        connection.close(4401, "unauthorized");
        return;
      }
    }
    connection.setState({ role });
    await super.onConnect(connection, ctx);
    try {
      connection.send(
        JSON.stringify({
          type: "init",
          history: this.messages.map((m) => ({ role: roleOf(m), text: textOf(m), citations: (m as any).metadata?.citations, ts: tsOf(m) })),
          mode: this.state.mode,
          persona: this.state.persona,
          verifiedActorId: this.state.verifiedActorId,
          handoffSummary: this.state.handoffSummary,
          handoffAt: this.state.handoffAt,
          slaMinutes: RESPONSE_SLA_MINUTES,
        }),
      );
    } catch {
      // koneksi mungkin sudah terputus sesaat setelah connect
    }
  }

  async onMessage(connection: Connection, message: WSMessage) {
    await super.onMessage(connection, message); // protokol chat AIChatAgent (customer) ditangani di sini -> men-trigger onChatMessage
    if (typeof message !== "string") return;
    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const role = (connection.state as any)?.role ?? "customer";

    if (msg.type === "cs_message" && role === "cs" && typeof msg.text === "string") {
      await this.persistMessages([...this.messages, { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: msg.text }], metadata: { source: "human" } } as UIMessage]);
      await appendAuditLog(this.env.DB, this.name, "human", "cs_reply", { text_len: msg.text.length });
      this.broadcast(JSON.stringify({ type: "message", role: "human", text: msg.text, ts: new Date().toISOString() }));
      await this.syncSessionsIndex(msg.text, "human");
      return;
    }

    if (msg.type === "takeover" && role === "cs") {
      this.setState({ ...this.state, mode: "HUMAN", handoffAt: this.state.handoffAt ?? new Date().toISOString() });
      await appendAuditLog(this.env.DB, this.name, "human", "mode_change", { mode: "HUMAN", reason: "cs_takeover" });
      this.broadcast(JSON.stringify({ type: "mode_change", mode: "HUMAN", reason: "cs_takeover" }));
      await this.syncSessionsIndex("(CS mengambil alih)", "human");
      return;
    }

    if (msg.type === "release" && role === "cs") {
      this.setState({ ...this.state, mode: "AI", handoffAt: null, handoffSummary: null });
      await appendAuditLog(this.env.DB, this.name, "human", "mode_change", { mode: "AI", reason: "cs_release" });
      this.broadcast(JSON.stringify({ type: "mode_change", mode: "AI", reason: "cs_release" }));
      await this.syncSessionsIndex("(CS mengembalikan ke AI)", "human");
      return;
    }

    if (msg.type === "typing") {
      const targetTag = role === "customer" ? "cs" : "customer";
      const json = JSON.stringify({ type: "typing", role, isTyping: !!msg.isTyping });
      for (const conn of this.getConnections(targetTag)) {
        try {
          conn.send(json);
        } catch {
          // observer mungkin baru saja disconnect
        }
      }
      return;
    }
  }

  /** Dipanggil framework AIChatAgent setiap pesan pengguna baru (customer) tiba lewat protokol chat. */
  async onChatMessage(_onFinish: any, options?: { body?: Record<string, unknown> }): Promise<Response> {
    const sessionId = this.name;
    const lastUser = [...this.messages].reverse().find((m) => m.role === "user");
    const userText = lastUser ? textOf(lastUser) : "";

    const bodyPersona = options?.body?.persona as Persona | undefined;
    const userTurnCount = this.messages.filter((m) => m.role === "user").length;
    const persona: Persona = userTurnCount <= 1 && bodyPersona ? bodyPersona : this.state.persona;

    if (this.state.mode === "HUMAN") {
      this.setState({ ...this.state, persona });
      return createUIMessageStreamResponse({ stream: instantTextStream("Percakapan ini sedang ditangani CS kami. Mohon tunggu balasan dari CS.") });
    }

    const pseudoSession = await pseudonymize(sessionId, PSEUDO_SALT);
    const xray = this.makeXrayRecorder();
    const trace = startTrace(this.langfuseConfig(), "chat_turn", { persona, userTextLen: userText.length }, { sessionId, persona, channel: "websocket" }, undefined, pseudoSession, xray.onXray);

    const result = await runAgentGraph(
      this.env,
      { sessionId, persona, userText, verifiedActorId: this.state.verifiedActorId, failedUnderstandingCount: this.state.failedUnderstandingCount },
      trace,
    );

    let handoffSummary = this.state.handoffSummary;
    let handoffAt = this.state.handoffAt;
    if (result.handoff.triggered) {
      handoffAt = new Date().toISOString();
      handoffSummary = await this.summarizeForHandoff();
      await appendAuditLog(this.env.DB, sessionId, "system", "mode_change", { mode: "HUMAN", reason: result.handoff.reason });
    }

    this.setState({
      persona,
      mode: result.handoff.triggered ? "HUMAN" : "AI",
      verifiedActorId: result.verifiedActorId,
      failedUnderstandingCount: result.blockedByGuard ? this.state.failedUnderstandingCount + 1 : 0,
      handoffSummary,
      handoffAt,
    });
    await this.syncSessionsIndex(result.answerText, "ai");
    if (result.handoff.triggered) {
      this.broadcast(JSON.stringify({ type: "mode_change", mode: "HUMAN", reason: result.handoff.reason, severity: result.handoff.severity, summary: handoffSummary }));
    }

    trace.score("passed_guard", result.blockedByGuard ? 0 : 1, result.blockedByGuard ?? "ok");
    trace.score("first_token_ms", result.timing.firstTokenMs ?? -1);
    this.ctx.waitUntil(trace.flush());

    const metaId = crypto.randomUUID();
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const textId = crypto.randomUUID();
        writer.write({ type: "text-start", id: textId });
        await relayFinalText(
          result.answerText,
          (chunk) => writer.write({ type: "text-delta", id: textId, delta: chunk }),
          result.instantDelivery,
        );
        writer.write({ type: "text-end", id: textId });
        writer.write({
          type: "data-meta",
          id: metaId,
          data: { citations: result.citations, intent: result.intent, blockedByGuard: result.blockedByGuard ?? null, timing: result.timing, modelUsed: result.modelUsed, xray: xray.events, traceId: trace.traceId },
        });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  /** Perekam event X-Ray untuk 1 giliran: broadcast live ke semua koneksi (customer + CS, panel
   * X-Ray & Red Team Arena) DAN dikumpulkan untuk disimpan sebagai metadata.xray pesan asisten
   * (replay oleh halaman /learn, lihat README §"Untuk halaman visual"). Skema event lihat
   * src/obs/langfuse.ts `XrayEvent` — field dibatasi sengaja, aman untuk mode Publik. */
  private makeXrayRecorder() {
    const events: XrayEvent[] = [];
    const onXray = (ev: XrayEvent) => {
      events.push(ev);
      this.broadcast(JSON.stringify({ type: "xray_event", event: ev }));
    };
    return { events, onXray };
  }

  /** Endpoint REST "legacy" (dipertahankan sama persis dengan v1) — dipakai scripts/run-eval.ts
   * (butuh JSON sinkron, bukan SSE stream) dan Konsol CS/Dashboard (lihat src/index.ts). */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = this.name;

    if (url.pathname.endsWith("/message") && request.method === "POST") {
      const body = await request.json<{ text: string; persona?: Persona }>();
      const bodyPersona = body.persona === "pendana" || body.persona === "petugas" ? body.persona : undefined;
      const userTurnCount = this.messages.filter((m) => m.role === "user").length;
      const persona: Persona = userTurnCount === 0 && bodyPersona ? bodyPersona : this.state.persona;

      if (this.state.mode === "HUMAN") {
        return jsonResponse({ reply: "Percakapan ini sedang ditangani CS kami. Mohon tunggu balasan dari CS.", mode: this.state.mode, verifiedActorId: this.state.verifiedActorId, persona });
      }

      const pseudoSession = await pseudonymize(sessionId, PSEUDO_SALT);
      const xray = this.makeXrayRecorder();
      const trace = startTrace(this.langfuseConfig(), "chat_turn", { persona, userTextLen: body.text.length }, { sessionId, persona, channel: "http_eval" }, undefined, pseudoSession, xray.onXray);

      const result = await runAgentGraph(this.env, { sessionId, persona, userText: body.text, verifiedActorId: this.state.verifiedActorId, failedUnderstandingCount: this.state.failedUnderstandingCount }, trace);

      let handoffSummary = this.state.handoffSummary;
      let handoffAt = this.state.handoffAt;
      if (result.handoff.triggered) {
        handoffAt = new Date().toISOString();
        handoffSummary = await this.summarizeForHandoff();
        await appendAuditLog(this.env.DB, sessionId, "system", "mode_change", { mode: "HUMAN", reason: result.handoff.reason });
      }
      this.setState({
        persona,
        mode: result.handoff.triggered ? "HUMAN" : "AI",
        verifiedActorId: result.verifiedActorId,
        failedUnderstandingCount: result.blockedByGuard ? this.state.failedUnderstandingCount + 1 : 0,
        handoffSummary,
        handoffAt,
      });
      await this.persistMessages([
        ...this.messages,
        { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: body.text }] } as UIMessage,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: result.answerText }],
          metadata: { citations: result.citations, intent: result.intent, blockedByGuard: result.blockedByGuard ?? null, xray: xray.events, traceId: trace.traceId },
        } as UIMessage,
      ]);
      await this.syncSessionsIndex(result.answerText, "ai");
      if (result.handoff.triggered) {
        this.broadcast(JSON.stringify({ type: "mode_change", mode: "HUMAN", reason: result.handoff.reason, severity: result.handoff.severity, summary: handoffSummary }));
      }
      trace.score("passed_guard", result.blockedByGuard ? 0 : 1, result.blockedByGuard ?? "ok");
      this.ctx.waitUntil(trace.flush());

      return jsonResponse({
        reply: result.answerText,
        citations: result.citations,
        intent: result.intent,
        mode: result.handoff.triggered ? "HUMAN" : "AI",
        verifiedActorId: result.verifiedActorId,
        persona,
        toolCallsMade: result.toolCallsMade,
        modelUsed: result.modelUsed,
        blockedByGuard: result.blockedByGuard,
        timing: result.timing,
        traceId: trace.traceId,
      });
    }

    if (url.pathname.endsWith("/history") && request.method === "GET") {
      return jsonResponse({
        persona: this.state.persona,
        mode: this.state.mode,
        verifiedActorId: this.state.verifiedActorId,
        handoffSummary: this.state.handoffSummary,
        handoffAt: this.state.handoffAt,
        history: this.messages.map((m) => ({ role: roleOf(m), text: textOf(m), citations: (m as any).metadata?.citations, ts: tsOf(m) })),
      });
    }

    if (url.pathname.endsWith("/takeover") && request.method === "POST") {
      this.setState({ ...this.state, mode: "HUMAN", handoffAt: this.state.handoffAt ?? new Date().toISOString() });
      await appendAuditLog(this.env.DB, sessionId, "human", "mode_change", { mode: "HUMAN", reason: "cs_takeover" });
      this.broadcast(JSON.stringify({ type: "mode_change", mode: "HUMAN", reason: "cs_takeover" }));
      await this.syncSessionsIndex("(CS mengambil alih)", "human");
      return jsonResponse({ ok: true, mode: "HUMAN" });
    }

    if (url.pathname.endsWith("/release") && request.method === "POST") {
      this.setState({ ...this.state, mode: "AI", handoffAt: null, handoffSummary: null });
      await appendAuditLog(this.env.DB, sessionId, "human", "mode_change", { mode: "AI", reason: "cs_release" });
      this.broadcast(JSON.stringify({ type: "mode_change", mode: "AI", reason: "cs_release" }));
      await this.syncSessionsIndex("(CS mengembalikan ke AI)", "human");
      return jsonResponse({ ok: true, mode: "AI" });
    }

    if (url.pathname.endsWith("/cs-reply") && request.method === "POST") {
      const body = await request.json<{ text: string }>();
      await this.persistMessages([...this.messages, { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: body.text }], metadata: { source: "human" } } as UIMessage]);
      await appendAuditLog(this.env.DB, sessionId, "human", "cs_reply", { text_len: body.text.length });
      this.broadcast(JSON.stringify({ type: "message", role: "human", text: body.text, ts: new Date().toISOString() }));
      await this.syncSessionsIndex(body.text, "human");
      return jsonResponse({ ok: true });
    }

    if (url.pathname.endsWith("/audit-verify") && request.method === "GET") {
      const result = await verifyChain(this.env.DB, sessionId);
      return jsonResponse(result);
    }

    return new Response("Not found", { status: 404 });
  }
}

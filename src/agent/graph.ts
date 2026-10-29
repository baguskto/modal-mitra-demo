// Alur agen sebagai LangGraph.js StateGraph eksplisit — menggantikan loop sekuensial manual yang
// sebelumnya ada di toolAgent.ts (lihat tag git `v1-pre-agents-sdk` untuk versi pra-migrasi).
//
// Node: guard_in -> verify_identity -> route_intent -> tools -> guard_out -> respond | handoff
// (persis urutan yang diminta brief interview). Setiap node HANYA memanggil ulang fungsi guard/
// router/rag/tools yang SAMA dan SUDAH lolos eval 45/45 sebelum migrasi ini — tidak ada logika
// keamanan/kepatuhan yang ditulis ulang dari nol, hanya diorganisasi ulang jadi node graph agar
// benar-benar auditable (bukan sekadar nama variabel "graph" di atas kode lama).
//
// Skema state dengan Zod (padanan Pydantic BaseModel di Python) — LangGraph.js native Zod state
// support (StateGraph(zodSchema)) sejak @langchain/langgraph ^0.2.5x, dipakai di sini apa adanya,
// BUKAN approximation Annotation.Root lama. Reducer default "last write wins" per key, cocok
// karena setiap node mengembalikan hanya field yang benar-benar berubah (partial update).
import { z } from "zod";
import { StateGraph, START, END } from "@langchain/langgraph";

import { redactPII, resolveTokens, resolveLeakedTokensInText } from "../guards/pii";
import { heuristicInjectionCheck, llamaGuardCheck, wrapAsData } from "../guards/injection";
import { checkScope } from "../guards/scope";
import { checkOutput, checkCitationsGrounded, checkMemberPrivacyLeak, FALLBACK_NOT_FOUND } from "../guards/output";
import { classifyIntent, detectHitl, type Intent, type Persona } from "./router";
import { retrieve, formatChunksAsContext } from "./rag";
import { buildSystemPrompt, buildUserTurn, buildToolResultTurn } from "./prompts";
import { callChatModel, type ChatMessage } from "./llm";
import { TOOL_REGISTRY, normalizeToolArgs, type ToolName } from "../tools/schemas";
import { executeTool } from "../tools/execute";
import { appendAuditLog } from "../obs/audit";
import type { LangfuseTrace } from "../obs/langfuse";

export interface AgentEnvBindings {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  MODEL_PRIMARY: string;
  MODEL_GUARD: string;
  EMBED_MODEL: string;
  KENARI_API_KEY?: string;
}

// 6 — lihat catatan historis di README §Keputusan Desain (3 terlalu kecil untuk verify->lookup->final).
const MAX_STEPS = 6;

const TicketLike = z.any().nullable();

const AgentState = z.object({
  sessionId: z.string(),
  persona: z.enum(["mitra", "pendana", "petugas"]),
  userText: z.string(),
  // FIX BLOCKER (temuan QA #2, "agen tanpa memori percakapan"): histori beberapa giliran
  // terakhir (lihat ChatAgent.recentHistory), supaya agen bisa menjawab pertanyaan yang
  // bergantung konteks ("tadi sy nanya apa aja", "iya bu" sebagai konfirmasi tawaran
  // sebelumnya) tanpa harus mengulang semuanya di 1 pesan.
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).default([]),
  verifiedActorId: z.string().nullable(),
  failedUnderstandingCount: z.number().default(0),
  // feat/extras fitur #2 (deteksi bahasa) — dihitung sekali di ChatAgent.onChatMessage sebelum
  // graph dipanggil (heuristik murah, tanpa LLM, lihat src/extras/language/) dan ditempelkan ke
  // system prompt di node respond (bukan field terpisah yang sengaja di-skip di sini).
  styleInstruction: z.string().optional(),

  redacted: z.string().default(""),
  vaultEntries: z.array(z.tuple([z.string(), z.string()])).default([]),
  allowedIds: z.array(z.string()).default([]),

  intent: z.string().default("lain"),
  toolCallsMade: z.array(z.object({ tool: z.string(), ok: z.boolean() })).default([]),

  autoTicket: TicketLike.default(null),
  autoDsr: TicketLike.default(null),
  autoRestru: TicketLike.default(null),

  finalText: z.string().default(""),
  citations: z.array(z.string()).default([]),
  modelUsed: z.string().default("none"),
  blockedByGuard: z.string().optional(),
  instantDelivery: z.boolean().default(false),

  handoffTriggered: z.boolean().default(false),
  handoffReason: z.string().optional(),
  handoffSeverity: z.string().default("normal"),

  usedRag: z.boolean().default(false),
  retrievedIds: z.array(z.string()).default([]),

  turnStartedAt: z.number(),
  firstTokenMs: z.number().nullable().default(null),
  totalMs: z.number().default(0),
});

type State = z.infer<typeof AgentState>;

interface RunConfigurable {
  env: AgentEnvBindings;
  trace: LangfuseTrace | null;
}

function safeParseAgentJson(text: string): { type: string; text?: string; citations?: string[]; tool?: string; args?: any } | null {
  if (!text) return null;
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// FIX (temuan QA MAJOR b, "JSON mentah bocor di bubble"): kalau safeParseAgentJson gagal (karena
// escaping rusak/trailing noise dll, ~2/25 balasan di uji ulang Red Team "Tool abuse" + balasan
// setelah release CS), SEBELUMNYA kode langsung memakai `llmRes.text` MENTAH sebagai jawaban --
// kalau teks itu sendiri adalah fragmen JSON yang gagal parse persis, pengguna melihat
// '...","citations":[...]}' mentah di bubble. Sekarang: coba ekstrak field "text" dengan regex
// dulu (lebih permisif dari JSON.parse ketat); kalau TETAP terlihat seperti JSON protokol internal
// (ada kurung kurawal + field "type"/"citations"/"tool"), JANGAN PERNAH tampilkan mentah --
// fallback ke pesan aman standar.
function extractAnswerFallback(raw: string): string {
  if (!raw) return FALLBACK_NOT_FOUND;
  const m = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`) || FALLBACK_NOT_FOUND;
    } catch {
      return m[1] || FALLBACK_NOT_FOUND;
    }
  }
  if (/^\s*\{[\s\S]*"(type|citations|tool)"\s*:/.test(raw)) return FALLBACK_NOT_FOUND;
  return raw;
}

// --- NODE: guard_in — injeksi (heuristik + Llama Guard) -> redaksi PII -> scope ---
async function nodeGuardIn(state: State, config: any): Promise<Partial<State>> {
  const { env, trace }: RunConfigurable = config.configurable;
  const span = trace?.span("guard_in", { textLen: state.userText.length });

  const heur = heuristicInjectionCheck(state.userText);
  if (heur.blocked) {
    await appendAuditLog(env.DB, state.sessionId, "system", "guard_block", { layer: "injection_heuristic", reason: heur.reason });
    span?.end({ blocked: true, layer: "injection_heuristic" }, "WARNING");
    return {
      blockedByGuard: "injection",
      instantDelivery: true,
      finalText: "Maaf, pesan Anda terdeteksi mengandung instruksi yang tidak dapat saya proses demi keamanan akun Anda. Jika ini kesalahan, silakan ajukan pertanyaan dengan kalimat lain, atau saya alihkan ke CS.",
    };
  }

  const { redacted, matches } = redactPII(state.userText);
  if (matches.length > 0) {
    await appendAuditLog(env.DB, state.sessionId, "system", "pii_redacted", { count: matches.length, types: matches.map((m) => m.type) });
  }

  const guardCheck = await llamaGuardCheck(env.AI, env.MODEL_GUARD, redacted);
  if (guardCheck.blocked) {
    await appendAuditLog(env.DB, state.sessionId, "system", "guard_block", { layer: "llama_guard", reason: guardCheck.reason });
    span?.end({ blocked: true, layer: "llama_guard" }, "WARNING");
    return {
      blockedByGuard: "llama_guard",
      instantDelivery: true,
      finalText: "Maaf, pesan Anda terdeteksi tidak aman untuk diproses otomatis. Saya alihkan ke CS manusia.",
    };
  }

  const scope = checkScope(state.userText);
  if (!scope.inScope) {
    await appendAuditLog(env.DB, state.sessionId, "system", "guard_block", { layer: "scope", reason: scope.reason });
    span?.end({ blocked: true, layer: "scope" }, "WARNING");
    return {
      blockedByGuard: "scope",
      instantDelivery: true,
      finalText: "Maaf, saya hanya dapat membantu hal-hal terkait layanan Modal Mitra Contoh (pinjaman, majelis, pendanaan, pengaduan, data pribadi). Untuk topik ini saya tidak bisa membantu.",
    };
  }

  span?.end({ blocked: false, piiRedactedCount: matches.length });
  return { redacted, vaultEntries: matches.map((m) => [m.token, m.original] as [string, string]) };
}

// --- NODE: verify_identity — auto-verify oportunistik bila pesan SENDIRI sudah menyertakan
// nomor pinjaman + tanggal lahir (pola identik dengan temuan review eval "keterlambatan" di
// README §7 poin 2, hanya sekarang dijalankan sebagai node tersendiri sebelum router, bukan
// disisipkan di tengah blok intent). classifyIntent dipanggil di sini juga (murah, sinkron,
// tanpa LLM) HANYA untuk menjaga gating PERSIS sama dengan versi pra-LangGraph: tidak menambah
// perilaku baru, hanya memindahkan posisi eksekusi agar sesuai urutan node yang diminta brief.
async function nodeVerifyIdentity(state: State, config: any): Promise<Partial<State>> {
  const { env, trace }: RunConfigurable = config.configurable;
  const span = trace?.span("verify_identity", {});
  if (state.verifiedActorId) {
    span?.end({ skipped: true, reason: "already_verified" });
    return {};
  }
  const intent = classifyIntent(state.userText, state.persona as Persona);
  if (!(intent === "keterlambatan" && state.persona === "mitra")) {
    span?.end({ skipped: true, reason: "gate_not_met" });
    return {};
  }
  const pinjamanMatch = state.userText.match(/\bMMK-\d{6}\b/i);
  const birthMatch = state.userText.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (!pinjamanMatch || !birthMatch) {
    span?.end({ skipped: true, reason: "no_pattern" });
    return {};
  }
  const verifyResult = await executeTool(env.DB, "verify_mitra", { pinjaman_no: pinjamanMatch[0].toUpperCase(), birth_date: birthMatch[0] }, { verifiedActorId: null, actorType: null, sessionId: state.sessionId });
  if (verifyResult.ok && verifyResult.data?.verified) {
    await appendAuditLog(env.DB, state.sessionId, "system", "tool_call", { tool: "verify_mitra", ok: true, auto: true });
    const actorId = String(verifyResult.data.actor_id);
    span?.end({ verified: true });
    return {
      verifiedActorId: actorId,
      allowedIds: [...new Set([...state.allowedIds, actorId.toUpperCase()])],
      toolCallsMade: [...state.toolCallsMade, { tool: "verify_mitra", ok: true }],
    };
  }
  span?.end({ verified: false });
  return {};
}

// --- NODE: route_intent — klasifikasi intent + HITL + aksi kepatuhan deterministik (tiket/DSR/restru) ---
async function nodeRouteIntent(state: State, config: any): Promise<Partial<State>> {
  const { env, trace }: RunConfigurable = config.configurable;
  const span = trace?.span("route_intent", {});
  const intent = classifyIntent(state.userText, state.persona as Persona);
  const explicitHumanRequest = /\b(bicara dengan (manusia|cs|petugas)|minta cs|mau cs|(sambung(in|kan)?|connect|m(i|n)ta|hubungkan)\b.{0,15}\b(cs|petugas|manusia))\b/i.test(state.userText.toLowerCase());
  const hitl = detectHitl(state.userText, state.failedUnderstandingCount, explicitHumanRequest);

  let autoTicket: any = null;
  const extraToolCalls: { tool: string; ok: boolean }[] = [];
  if (intent === "pengaduan") {
    const category = /penagihan|debt collector|\bdc\b/i.test(state.userText)
      ? "penagihan"
      : /data pribadi|kebocoran data|anggota majelis lain/i.test(state.userText)
        ? "data_pribadi"
        : state.persona === "pendana" || /pendanaan|pencairan dana|imbal hasil/i.test(state.userText)
          ? "pendanaan"
          : /produk|bunga|biaya|syarat/i.test(state.userText)
            ? "produk"
            : "layanan";
    const ticketSeverity = hitl.shouldHandoff ? hitl.severity : "normal";
    const result = await executeTool(
      env.DB,
      "create_complaint_ticket",
      { category, severity: ticketSeverity, subject: state.userText.slice(0, 100), description: state.userText },
      { verifiedActorId: state.verifiedActorId, actorType: state.persona === "pendana" ? "pendana" : "mitra", sessionId: state.sessionId },
    );
    if (result.ok) {
      autoTicket = result.data;
      extraToolCalls.push({ tool: "create_complaint_ticket", ok: true });
      await appendAuditLog(env.DB, state.sessionId, "system", "tool_call", { tool: "create_complaint_ticket", ok: true, auto: true });
    }
  }

  if (hitl.shouldHandoff) {
    await appendAuditLog(env.DB, state.sessionId, "system", "handoff", { reason: hitl.reason, severity: hitl.severity, ticket_id: autoTicket?.ticket_id ?? null });
    const sev = hitl.severity === "critical" ? "Permintaan Anda sangat penting dan langsung kami eskalasi dengan prioritas tinggi." : "Baik, saya alihkan percakapan ini ke tim CS kami.";
    const ticketLine = autoTicket ? ` Pengaduan Anda sudah tercatat dengan nomor tiket ${autoTicket.ticket_id}.` : "";
    const text = `${sev}${ticketLine} Mohon tunggu sebentar, CS kami akan segera membantu Anda.`;
    span?.end({ intent, handoff: true, severity: hitl.severity });
    return {
      intent,
      autoTicket,
      toolCallsMade: [...state.toolCallsMade, ...extraToolCalls],
      handoffTriggered: true,
      instantDelivery: true,
      handoffReason: hitl.reason,
      handoffSeverity: hitl.severity,
      finalText: text,
    };
  }

  let autoDsr: any = null;
  if (intent === "hak_data") {
    const requestType = /hapus/i.test(state.userText)
      ? "delete"
      : /koreksi|perbaiki|ubah/i.test(state.userText)
        ? "correction"
        : /keberatan|automated|otomatis/i.test(state.userText)
          ? "object_automated_decision"
          : "access";
    const result = await executeTool(env.DB, "create_dsr_request", { request_type: requestType, detail: state.userText.slice(0, 500) }, { verifiedActorId: state.verifiedActorId, actorType: state.persona === "pendana" ? "pendana" : "mitra", sessionId: state.sessionId });
    if (result.ok) {
      autoDsr = result.data;
      extraToolCalls.push({ tool: "create_dsr_request", ok: true });
      await appendAuditLog(env.DB, state.sessionId, "system", "tool_call", { tool: "create_dsr_request", ok: true, auto: true });
    }
  }

  // FIX BLOCKER (temuan QA #2): SEBELUMNYA setiap pesan ber-intent "keterlambatan" dari mitra
  // terverifikasi otomatis membuat restrukturisasi BARU -- termasuk saat user hanya menjawab "iya
  // bu" terhadap tawaran AI (reason tercatat literal "iya bu", bukan konteks), DAN saat user
  // bertanya ulang ("jd keringanan sy gmn kelanjutannya?") ikut membuat entri DUPLIKAT. Sekarang:
  // (1) hanya dibuat kalau user secara EKSPLISIT minta/sebut restrukturisasi/keringanan, ATAU
  // balasan singkat ("iya"/"ya"/"oke"/"boleh"/"setuju"/"lanjut") yang MERESPONS tawaran AI
  // sebelumnya (dicek dari history, bukan ditebak); (2) idempotency ditegakkan lagi di
  // executeTool (src/tools/execute.ts) -- kalau sudah ada permintaan aktif, dikembalikan
  // statusnya yang SUDAH ADA, tidak membuat baris baru.
  let autoRestru: any = null;
  if (intent === "keterlambatan" && state.persona === "mitra" && state.verifiedActorId) {
    const lastAssistantText = [...state.history].reverse().find((h) => h.role === "assistant")?.text ?? "";
    const offeredKeringanan = /keringanan|restrukturisasi|perpanjang(an)?/i.test(lastAssistantText);
    const explicitRestruRequest = /restrukturisasi|keringanan|perpanjang|ajukan/i.test(state.userText);
    const briefConfirm = /^\s*(iya|ya|yap|oke|ok|boleh|setuju|lanjut(kan)?)\b/i.test(state.userText.trim());
    const shouldCreateRestru = explicitRestruRequest || (briefConfirm && offeredKeringanan);
    if (shouldCreateRestru) {
      const reason = explicitRestruRequest
        ? state.userText.slice(0, 500)
        : `Konfirmasi atas tawaran sebelumnya ("${lastAssistantText.slice(0, 150)}") — balasan mitra: "${state.userText.slice(0, 150)}"`;
      const result = await executeTool(env.DB, "create_restructuring_request", { reason }, { verifiedActorId: state.verifiedActorId, actorType: "mitra", sessionId: state.sessionId });
      if (result.ok) {
        autoRestru = result.data;
        extraToolCalls.push({ tool: "create_restructuring_request", ok: true });
        await appendAuditLog(env.DB, state.sessionId, "system", "tool_call", { tool: "create_restructuring_request", ok: true, auto: true, idempotent: result.data?.alreadyExisted ?? false });
      }
    }
  }

  span?.end({ intent, handoff: false });
  return { intent, autoTicket, autoDsr, autoRestru, toolCallsMade: [...state.toolCallsMade, ...extraToolCalls] };
}

// --- NODE: tools — RAG retrieval + loop ReAct terbatas (<=MAX_STEPS) tool_call|final_answer ---
async function nodeTools(state: State, config: any): Promise<Partial<State>> {
  const { env, trace }: RunConfigurable = config.configurable;
  const span = trace?.span("tools", { intent: state.intent });
  const allowedIds = new Set(state.allowedIds);
  const vault = new Map(state.vaultEntries);
  let verifiedActorId = state.verifiedActorId;

  const chunks = await retrieve(env.AI, env.VECTORIZE, env.EMBED_MODEL, state.userText, 8, env.KENARI_API_KEY);
  const retrievedIds = new Set(chunks.map((c) => c.id.toLowerCase()));
  await appendAuditLog(env.DB, state.sessionId, "system", "retrieve", { query_redacted: state.redacted, result_ids: [...retrievedIds], count: chunks.length });
  const usedRag = chunks.length > 0;

  let ragContext = formatChunksAsContext(chunks);
  if (state.autoTicket) ragContext += `\n---\n${wrapAsData("tiket_pengaduan_otomatis", JSON.stringify(state.autoTicket))}\nSistem sudah mencatat pengaduan ini sebagai tiket ${state.autoTicket.ticket_id} dengan tenggat ${state.autoTicket.sla_due_at}. Sebutkan nomor tiket dan tenggat ini di jawaban Anda.`;
  if (state.autoDsr) ragContext += `\n---\n${wrapAsData("dsr_otomatis", JSON.stringify(state.autoDsr))}\nSistem sudah mencatat permintaan hak data ini sebagai ${state.autoDsr.dsr_id}. Jelaskan bahwa permintaan TIDAK dieksekusi otomatis dan akan ditinjau tim berwenang, sebutkan nomor ${state.autoDsr.dsr_id}.`;
  if (state.autoRestru) ragContext += `\n---\n${wrapAsData("restrukturisasi_otomatis", JSON.stringify(state.autoRestru))}\nSistem sudah mencatat permintaan restrukturisasi/keringanan ini sebagai ${state.autoRestru.restru_id}. Jelaskan bahwa ini akan ditinjau petugas lapangan/tim kredit, TIDAK ADA keputusan/jaminan otomatis, sebutkan nomor ${state.autoRestru.restru_id}.`;

  // FIX BLOCKER (temuan QA #2): histori giliran sebelumnya disisipkan sebagai pesan user/assistant
  // biasa SEBELUM giliran saat ini -- supaya LLM benar-benar "ingat" apa yang sudah dibahas (tidak
  // perlu diulang-ulang token redaksi/RAG untuk giliran lama, cukup teks percakapan apa adanya).
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(state.persona as Persona, verifiedActorId, state.styleInstruction) },
    ...state.history.slice(-10).map((h): ChatMessage => ({ role: h.role, content: h.text })),
    { role: "user", content: buildUserTurn(state.redacted, wrapAsData("konteks_rag", ragContext)) },
  ];

  let finalText = "";
  let citations: string[] = [];
  let modelUsed = "none";
  const toolCallsMade: { tool: string; ok: boolean }[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const llmRes = await callChatModel(env.AI, env.MODEL_PRIMARY, messages, {}, env.KENARI_API_KEY);
    modelUsed = llmRes.modelUsed;
    await appendAuditLog(env.DB, state.sessionId, "ai", "llm_call", { step, model: llmRes.modelUsed, degraded: llmRes.degraded });
    trace?.generation(`llm_call_step_${step}`, llmRes.modelUsed, messages[messages.length - 1], llmRes.text);

    const parsed = safeParseAgentJson(llmRes.text);
    if (!parsed) {
      finalText = extractAnswerFallback(llmRes.text);
      break;
    }
    if (parsed.type === "final_answer") {
      finalText = parsed.text ?? "";
      citations = Array.isArray(parsed.citations) ? parsed.citations : [];
      break;
    }
    if (parsed.type === "tool_call") {
      const toolName = parsed.tool as ToolName;
      const def = TOOL_REGISTRY[toolName];
      if (!def) {
        messages.push({ role: "assistant", content: llmRes.text });
        messages.push({ role: "user", content: buildToolResultTurn(parsed.tool ?? "unknown", JSON.stringify({ ok: false, error: "tool tidak dikenal" })) });
        continue;
      }
      const resolvedArgs = normalizeToolArgs(resolveTokens(parsed.args ?? {}, vault));
      const argsParse = def.schema.safeParse(resolvedArgs);
      if (!argsParse.success) {
        await appendAuditLog(env.DB, state.sessionId, "system", "tool_call_invalid", { tool: toolName, issues: argsParse.error.issues });
        messages.push({ role: "assistant", content: llmRes.text });
        messages.push({ role: "user", content: buildToolResultTurn(toolName, JSON.stringify({ ok: false, error: "argumen tidak valid" })) });
        continue;
      }

      const actorType: "mitra" | "pendana" | null = state.persona === "pendana" ? "pendana" : state.persona === "mitra" ? "mitra" : null;

      let result: { ok: boolean; data?: any; error?: string };
      if (toolName === "create_complaint_ticket" && state.autoTicket) result = { ok: true, data: state.autoTicket };
      else if (toolName === "create_dsr_request" && state.autoDsr) result = { ok: true, data: state.autoDsr };
      else if (toolName === "create_restructuring_request" && state.autoRestru) result = { ok: true, data: state.autoRestru };
      else result = await executeTool(env.DB, toolName, argsParse.data as any, { verifiedActorId, actorType, sessionId: state.sessionId });

      toolCallsMade.push({ tool: toolName, ok: result.ok });
      await appendAuditLog(env.DB, state.sessionId, "ai", "tool_call", { tool: toolName, ok: result.ok });

      if ((toolName === "verify_mitra" || toolName === "verify_pendana") && result.ok && result.data?.verified) {
        verifiedActorId = result.data.actor_id;
        allowedIds.add(String(verifiedActorId).toUpperCase());
        // FIX (temuan QA MAJOR a, "X-Ray node 2· Verify selalu 'skip' walau verifikasi sukses"):
        // node verify_identity SUDAH SELESAI (fase sebelum tools) saat verifikasi ini baru terjadi
        // di SINI (lewat tool_call LLM, bukan auto-verify pola-ketat). Tanpa event tambahan, panel
        // X-Ray tetap menampilkan node 2 sebagai "skip" walau verifikasi SUKSES di giliran yang
        // sama -- emit event susulan untuk node yang sama supaya panel menunjukkan status nyata.
        trace?.span("verify_identity", { viaToolCall: true }).end({ verified: true, via: "tool_call" });
      }
      if (toolName === "handoff_to_human" && result.ok) {
        await appendAuditLog(env.DB, state.sessionId, "system", "handoff", { reason: result.data?.reason ?? "tool_call_llm", severity: "normal", ticket_id: state.autoTicket?.ticket_id ?? null });
        const ticketLine = state.autoTicket ? ` Pengaduan Anda sudah tercatat dengan nomor tiket ${state.autoTicket.ticket_id}.` : "";
        const text = `Baik, saya alihkan percakapan ini ke tim CS kami.${ticketLine} Mohon tunggu sebentar, CS kami akan segera membantu Anda.`;
        span?.end({ handoffMidLoop: true, steps: step + 1 });
        return {
          handoffTriggered: true,
          instantDelivery: true,
          handoffReason: result.data?.reason ?? "tool_call_llm",
          handoffSeverity: "normal",
          finalText: text,
          modelUsed: llmRes.modelUsed,
          verifiedActorId,
          allowedIds: [...allowedIds],
          toolCallsMade: [...state.toolCallsMade, ...toolCallsMade],
        };
      }
      if (toolName === "get_angsuran" && result.ok) {
        for (const row of result.data?.angsuran ?? []) allowedIds.add(String(row.pinjaman_no).toUpperCase());
      }
      if (toolName === "get_portofolio" && result.ok) {
        for (const row of result.data?.pendanaan ?? []) allowedIds.add(String(row.pendanaan_id).toUpperCase());
      }

      messages.push({ role: "assistant", content: llmRes.text });
      messages.push({ role: "user", content: buildToolResultTurn(toolName, JSON.stringify(result)) });
      continue;
    }

    finalText = extractAnswerFallback(llmRes.text);
    break;
  }

  if (!finalText) finalText = FALLBACK_NOT_FOUND;
  // FIX (temuan QA MAJOR a, "panel Tools 0 langkah padahal tool jalan"): `toolCallsMade` lokal
  // hanya menghitung tool yang dipanggil DI DALAM loop node ini -- tool yang sudah jalan di node
  // sebelumnya (mis. verify_mitra via auto-verify di verify_identity, atau create_complaint_ticket
  // di route_intent) tidak ikut terhitung walau SUDAH jalan di giliran ini, jadi panel X-Ray bisa
  // menampilkan "0 langkah" walau tool sungguhan jalan. Hitung KUMULATIF dari seluruh giliran.
  span?.end({ steps: state.toolCallsMade.length + toolCallsMade.length, model: modelUsed });
  return {
    finalText,
    citations,
    modelUsed,
    verifiedActorId,
    allowedIds: [...allowedIds],
    toolCallsMade: [...state.toolCallsMade, ...toolCallsMade],
    retrievedIds: [...retrievedIds],
    usedRag,
  };
}

// --- NODE: guard_out — de-tokenisasi, larangan janji + sitasi wajib + groundedness, privasi antar-majelis ---
async function nodeGuardOut(state: State, config: any): Promise<Partial<State>> {
  const { env, trace }: RunConfigurable = config.configurable;
  const span = trace?.span("guard_out", {});
  const vault = new Map(state.vaultEntries);
  let finalText = resolveLeakedTokensInText(state.finalText, vault);
  // Jaring pengaman terakhir (temuan QA MAJOR b): titik konvergensi SEMUA jalur non-instant (tools
  // -> guard_out) -- kalau finalText MASIH terlihat seperti JSON protokol internal mentah
  // (apa pun sebabnya), jangan pernah lanjut ke pengguna seperti itu.
  if (/^\s*\{[\s\S]*"(type|citations|tool)"\s*:/.test(finalText)) finalText = FALLBACK_NOT_FOUND;
  let citations = state.citations;
  let blockedByGuard: string | undefined;

  const citationRelevant = state.usedRag && state.intent !== "akun";
  const outputCheck = checkOutput(finalText, citationRelevant);
  if (!outputCheck.ok) {
    await appendAuditLog(env.DB, state.sessionId, "system", "output_guard_block", { reason: outputCheck.reason, piiLeak: outputCheck.piiLeak });
    finalText = FALLBACK_NOT_FOUND;
    citations = [];
    blockedByGuard = outputCheck.reason;
  } else if (citations.length > 0) {
    const grounded = checkCitationsGrounded(finalText, new Set(state.retrievedIds));
    if (!grounded.grounded) {
      await appendAuditLog(env.DB, state.sessionId, "system", "output_guard_block", { reason: "sitasi tidak ditemukan di konteks", invalid: grounded.invalid });
      finalText = FALLBACK_NOT_FOUND;
      citations = [];
      blockedByGuard = "sitasi_tidak_grounded";
    }
  }
  if (!blockedByGuard) {
    const privacyCheck = checkMemberPrivacyLeak(finalText, new Set(state.allowedIds));
    if (!privacyCheck.ok) {
      await appendAuditLog(env.DB, state.sessionId, "system", "output_guard_block", { reason: "privasi_antar_majelis", leaked: privacyCheck.leaked });
      finalText = "Maaf, saya tidak dapat menampilkan data yang bukan milik Anda. Jika ini terkait data Anda sendiri, mohon verifikasi ulang; untuk hal lain saya alihkan ke CS.";
      citations = [];
      blockedByGuard = "privasi_antar_majelis";
    }
  }

  if (state.autoTicket && !finalText.includes(state.autoTicket.ticket_id)) {
    finalText += `\n\nPengaduan Anda telah dicatat dengan nomor tiket ${state.autoTicket.ticket_id}, akan ditindaklanjuti paling lambat ${new Date(state.autoTicket.sla_due_at).toLocaleDateString("id-ID")} sesuai SOP penanganan pengaduan kami.`;
  }
  if (state.autoDsr && !finalText.includes(state.autoDsr.dsr_id)) {
    finalText += `\n\nPermintaan hak data Anda telah dicatat dengan nomor ${state.autoDsr.dsr_id}. Permintaan ini akan ditinjau oleh tim yang berwenang dan tidak dieksekusi secara otomatis.`;
  }
  if (state.autoRestru && !finalText.includes(state.autoRestru.restru_id)) {
    finalText += `\n\nPermintaan restrukturisasi/keringanan Anda telah dicatat dengan nomor ${state.autoRestru.restru_id}, akan ditinjau petugas lapangan/tim kredit. Tidak ada keputusan otomatis.`;
  }

  span?.end({ blocked: !!blockedByGuard, reason: blockedByGuard });
  return { finalText, citations, blockedByGuard };
}

// --- NODE: respond — bookkeeping akhir (audit "output", timing) ---
async function nodeRespond(state: State, config: any): Promise<Partial<State>> {
  const { env, trace }: RunConfigurable = config.configurable;
  const span = trace?.span("respond", {});
  await appendAuditLog(env.DB, state.sessionId, "ai", "output", { text_len: state.finalText.length, citations: state.citations, intent: state.intent });
  const totalMs = Date.now() - state.turnStartedAt;
  // instantDelivery (blokir guard_in / handoff) -> firstToken = 0 (balasan kanal langsung, tidak
  // direlai kata-per-kata); jalur normal (termasuk yang diblokir guard_out) -> firstToken = saat
  // teks SIAP direlai (identik dengan semantik versi pra-LangGraph, lihat toolAgent.ts di tag v1).
  const firstTokenMs = state.instantDelivery ? 0 : totalMs;
  span?.end({ totalMs, firstTokenMs });
  trace?.update({ output: { text: state.finalText, citations: state.citations, blockedByGuard: state.blockedByGuard, handoff: state.handoffTriggered } });
  return { totalMs, firstTokenMs };
}

function buildGraph() {
  const graph = new StateGraph(AgentState)
    .addNode("guard_in", nodeGuardIn)
    .addNode("verify_identity", nodeVerifyIdentity)
    .addNode("route_intent", nodeRouteIntent)
    .addNode("tools", nodeTools)
    .addNode("guard_out", nodeGuardOut)
    .addNode("respond", nodeRespond)
    .addEdge(START, "guard_in")
    .addConditionalEdges("guard_in", (s: State) => (s.blockedByGuard ? "respond" : "verify_identity"), ["respond", "verify_identity"])
    .addEdge("verify_identity", "route_intent")
    .addConditionalEdges("route_intent", (s: State) => (s.handoffTriggered ? "respond" : "tools"), ["respond", "tools"])
    .addConditionalEdges("tools", (s: State) => (s.handoffTriggered ? "respond" : "guard_out"), ["respond", "guard_out"])
    .addEdge("guard_out", "respond")
    .addEdge("respond", END);
  return graph.compile();
}

const COMPILED_GRAPH = buildGraph();

export interface AgentTurnInput {
  sessionId: string;
  persona: Persona;
  userText: string;
  /** Histori beberapa giliran terakhir (lihat ChatAgent.recentHistory) -- fix BLOCKER memori. */
  history?: { role: "user" | "assistant"; text: string }[];
  verifiedActorId: string | null;
  failedUnderstandingCount: number;
  styleInstruction?: string;
}

export interface AgentTurnOutput {
  answerText: string;
  citations: string[];
  intent: Intent;
  handoff: { triggered: boolean; reason?: string; severity: string };
  verifiedActorId: string | null;
  toolCallsMade: { tool: string; ok: boolean }[];
  modelUsed: string;
  blockedByGuard?: string;
  instantDelivery: boolean;
  timing: { firstTokenMs: number | null; totalMs: number };
}

/** Relay teks akhir per kata dengan jeda kecil -> "mengalir" di UI tanpa bergantung pada streaming
 * token mentah dari model (lihat README §Keputusan Desain — bug streaming Workers AI untuk model
 * ini). Dipanggil oleh pemanggil (ChatAgent/eval), BUKAN node graph — I/O pengiriman ke klien
 * sengaja dipisah dari logika keputusan agen. */
export async function relayFinalText(text: string, onToken: (token: string) => void, instant: boolean): Promise<void> {
  if (!text) return;
  if (instant) {
    onToken(text);
    return;
  }
  const chunks = text.match(/\S+\s*|\s+/g) ?? [text];
  for (const chunk of chunks) {
    onToken(chunk);
    await new Promise((resolve) => setTimeout(resolve, 18));
  }
}

export async function runAgentGraph(env: AgentEnvBindings, input: AgentTurnInput, trace: LangfuseTrace | null = null): Promise<AgentTurnOutput> {
  const initial: State = {
    sessionId: input.sessionId,
    persona: input.persona,
    userText: input.userText,
    history: input.history ?? [],
    verifiedActorId: input.verifiedActorId,
    failedUnderstandingCount: input.failedUnderstandingCount,
    styleInstruction: input.styleInstruction,
    redacted: "",
    vaultEntries: [],
    allowedIds: input.verifiedActorId ? [input.verifiedActorId.toUpperCase()] : [],
    intent: "lain",
    toolCallsMade: [],
    autoTicket: null,
    autoDsr: null,
    autoRestru: null,
    finalText: "",
    citations: [],
    modelUsed: "none",
    blockedByGuard: undefined,
    instantDelivery: false,
    handoffTriggered: false,
    handoffReason: undefined,
    handoffSeverity: "normal",
    usedRag: false,
    retrievedIds: [],
    turnStartedAt: Date.now(),
    firstTokenMs: null,
    totalMs: 0,
  };

  const final = (await COMPILED_GRAPH.invoke(initial, { configurable: { env, trace } })) as State;

  return {
    answerText: final.finalText,
    citations: final.citations,
    intent: final.intent as Intent,
    handoff: { triggered: final.handoffTriggered, reason: final.handoffReason, severity: final.handoffSeverity },
    verifiedActorId: final.verifiedActorId,
    toolCallsMade: final.toolCallsMade,
    modelUsed: final.modelUsed,
    blockedByGuard: final.blockedByGuard,
    instantDelivery: final.instantDelivery,
    timing: { firstTokenMs: final.firstTokenMs, totalMs: final.totalMs },
  };
}

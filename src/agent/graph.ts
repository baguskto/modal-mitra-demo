// Alur agen sebagai LangGraph.js StateGraph eksplisit — menggantikan loop sekuensial manual yang
// sebelumnya ada di toolAgent.ts (lihat tag git `v1-pre-agents-sdk` untuk versi pra-migrasi).
//
// Node: guard_in -> verify_identity -> route_intent -> tools -> guard_out -> respond | handoff
//
// feat/latency-xray (2 Nov 2026) — kasus nyata: "aduh maap bu kemarin blm bisa bayar angsuran, gimana
// ya" -> first-token = total = 20.8 s, intent salah "lain", Tools "0 langkah". Perubahan:
//  1. guard_in: cek deterministik (regex) dulu; Llama Guard, retrieval RAG, dan klasifikasi intent
//     cadangan (model cepat) lalu berjalan PARALEL — bukan berurutan.
//  2. verify_identity: auto-verify dua faktor untuk mitra (MMK + tgl lahir) DAN pendana (PND + tgl
//     lahir) apa pun intent-nya — sebelumnya jalur umum "cek angsuran ..." butuh 3 putaran LLM ReAct.
//  3. route_intent: regex informal diperluas (router.ts) + cadangan LLM few-shot bila aturan = "lain".
//  4. tools: data akun yang pasti dibutuhkan intent diambil DETERMINISTIK (prefetch); ReAct JSON
//     hanya dipakai bila LLM benar-benar perlu memilih tool (mis. identitas belum terverifikasi tapi
//     pengguna menyebut nomor). Jawaban akhir = SATU panggilan LLM streaming teks polos.
//  5. guard_out: berjalan SELAMA streaming, per kalimat (src/guards/streamGuard.ts) — teks melanggar
//     tidak pernah sampai ke UI. Cek akhir (sitasi wajib, baris tiket/DSR/restru) di node guard_out.
//  6. Audit log ditulis lewat antrean berurutan (hash-chain tetap urut) di luar jalur kritis, ditunggu
//     di node respond (setelah teks selesai tampil).
//  7. Setiap span X-Ray membawa detail: teknik, panggilan model/tool (argumen di-mask), RAG + skor,
//     langkah ReAct, aturan guard (src/obs/xrayDetail.ts).
import { z } from "zod";
import { StateGraph, START, END } from "@langchain/langgraph";

import { redactPII, resolveTokens, maskPIIForHistory } from "../guards/pii";
import { heuristicInjectionCheck, llamaGuardCheck, wrapAsData, type InjectionResult } from "../guards/injection";
import { checkScope } from "../guards/scope";
import { checkDataIntegrityAbuse } from "../guards/dataIntegrity";
import { checkThirdPartyPiiRequest } from "../guards/privacy";
import { salvageJsonTail, FALLBACK_NOT_FOUND } from "../guards/output";
import { StreamGuard, type GuardBlockReason } from "../guards/streamGuard";
import { classifyIntent, detectHitl, type Intent, type Persona } from "./router";
import { classifyIntentFast, type LlmIntentResult } from "./classify";
import { retrieve, formatChunksAsContext, type RetrievalResult } from "./rag";
import { buildSystemPrompt, buildUserTurn, buildToolResultTurn, buildStreamingAnswerTurn } from "./prompts";
import { callChatModel, streamChatModel, type ChatMessage } from "./llm";
import { TOOL_REGISTRY, normalizeToolArgs, normalizeBirthDate, type ToolName } from "../tools/schemas";
import { executeTool } from "../tools/execute";
import { appendAuditLog } from "../obs/audit";
import { WorkersAiBudget, meteredAi, RACE_CAP } from "./aiBudget";
import type { LangfuseTrace } from "../obs/langfuse";
import { TECH, maskArgs, summarizeToolResult, sanitizeThought, safeToolName, type XrayCall, type XrayGuardRule, type XrayReactStep, type XrayTechnique } from "../obs/xrayDetail";

export interface AgentEnvBindings {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  MODEL_PRIMARY: string;
  MODEL_GUARD: string;
  EMBED_MODEL: string;
  KENARI_API_KEY?: string;
  /** Model chat Kenari (harus anggota scope_models paket & billing plan — lihat kenari.ts PLAN_MODELS). */
  KENARI_CHAT_MODEL?: string;
  /** Model Kenari kedua (upstream berbeda) untuk hedged request — juga wajib plan. */
  KENARI_HEDGE_MODEL?: string;
  /** ms tanpa token pertama dari Kenari sebelum model Kenari kedua dijalankan paralel. */
  LLM_HEDGE_AFTER_MS?: string;
  /** ms sebelum Workers AI (co-located) ikut balapan; "0" = balapan sejak awal. Default = LLM_HEDGE_AFTER_MS. */
  WORKERS_AI_RACE_AFTER_MS?: string;
}

// 6 — lihat catatan historis di README §Keputusan Desain (3 terlalu kecil untuk verify->lookup->final).
const MAX_STEPS = 6;
const LLAMA_GUARD_TIMEOUT_MS = 1500;
// Anggaran total klasifikasi cadangan (dimulai di guard_in) — tidak boleh menahan jalur kritis lama.
const INTENT_LLM_BUDGET_MS = 1200;

const TicketLike = z.any().nullable();

const AgentState = z.object({
  sessionId: z.string(),
  persona: z.enum(["mitra", "pendana", "petugas"]),
  userText: z.string(),
  // FIX BLOCKER (temuan QA #2, "agen tanpa memori percakapan"): histori beberapa giliran terakhir.
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).default([]),
  verifiedActorId: z.string().nullable(),
  failedUnderstandingCount: z.number().default(0),
  // feat/extras fitur #2 (deteksi bahasa) — dihitung di ChatAgent sebelum graph dipanggil.
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
  // FIX (temuan QA M2): atribusi jujur "LLM menolak sendiri" (bukan guard) untuk X-Ray/Red Team.
  modelRefused: z.boolean().default(false),
  blockedByGuard: z.string().optional(),
  instantDelivery: z.boolean().default(false),
  /** true bila guard streaming mengganti bubble yang sudah sebagian tampil (lihat streamGuard.ts). */
  replaced: z.boolean().default(false),

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

/** Penerima teks yang SUDAH lolos guard (ChatAgent -> UIMessageStream). Opsional: jalur eval HTTP tidak streaming. */
export interface TurnSink {
  text(delta: string): void | Promise<void>;
  replace(text: string, reason: GuardBlockReason): void | Promise<void>;
}

/** Objek per-giliran yang TIDAK masuk state (promise paralel, guard streaming, antrean audit). */
interface RunBag {
  sink: TurnSink | null;
  llamaGuard?: Promise<InjectionResult & { ms: number }>;
  retrieval?: Promise<RetrievalResult>;
  llmIntent?: Promise<LlmIntentResult | null>;
  streamGuard?: StreamGuard;
  guardOutSpan?: { end: (o?: Record<string, unknown>, level?: "DEFAULT" | "WARNING" | "ERROR") => void };
  guardOutStartedAt?: number;
  firstTokenAt?: number;
  auditQ: Promise<unknown>;
  ragDetail?: Record<string, unknown>;
  budget: WorkersAiBudget;
}

interface RunConfigurable {
  env: AgentEnvBindings;
  trace: LangfuseTrace | null;
  bag: RunBag;
}

function audit(bag: RunBag, db: D1Database, sessionId: string, actor: "ai" | "system" | "human" | "user", event: string, payload: Record<string, unknown>) {
  // Antrean berurutan: hash-chain audit tetap urut, tapi tidak menahan jalur kritis (ditunggu di respond).
  bag.auditQ = bag.auditQ.then(() => appendAuditLog(db, sessionId, actor as any, event, payload)).catch((e) => console.error("audit_error", e?.message ?? e));
}

function since(state: State): number {
  return Date.now() - state.turnStartedAt;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

function safeParseAgentJson(text: string): { type: string; text?: string; citations?: string[]; tool?: string; args?: any; thought?: string } | null {
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

// FIX (temuan QA MAJOR b, "JSON mentah bocor di bubble") + re-test 30 Okt (ekor JSON): lihat riwayat
// di tag v1/commit 32f80c6 — tidak pernah menampilkan JSON protokol mentah.
export function extractAnswerFallback(raw: string): { text: string; citations: string[] } {
  if (!raw) return { text: FALLBACK_NOT_FOUND, citations: [] };
  const parsed = safeParseAgentJson(raw);
  if (parsed?.type === "final_answer" && typeof parsed.text === "string") return { text: parsed.text || FALLBACK_NOT_FOUND, citations: Array.isArray(parsed.citations) ? parsed.citations : [] };
  const m = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    const cit = salvageJsonTail(raw)?.citations ?? [];
    try {
      return { text: JSON.parse(`"${m[1]}"`) || FALLBACK_NOT_FOUND, citations: cit };
    } catch {
      return { text: m[1] || FALLBACK_NOT_FOUND, citations: cit };
    }
  }
  const tail = salvageJsonTail(raw);
  if (tail && tail.text) return tail;
  if (/^\s*\{[\s\S]*"(type|citations|tool)"\s*:/.test(raw)) return { text: FALLBACK_NOT_FOUND, citations: [] };
  return { text: raw, citations: [] };
}

// FIX (temuan QA M2): heuristik kata kunci penolakan Bahasa Indonesia untuk atribusi layer yang jujur.
const REFUSAL_PATTERNS: RegExp[] = [
  /\btidak (bisa|dapat|boleh|berwenang|diizinkan)\b/i,
  /\bmaaf,? (saya )?(tidak|tdk)\b/i,
  /\b(bukan|di luar) kewenangan saya\b/i,
  /\bmenolak\b/i,
  /\btidak (akan|pernah) (menghapus|mengubah|membocorkan|menampilkan|menjamin)\b/i,
];
function looksLikeRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(text));
}

function techs(...t: XrayTechnique[]): XrayTechnique[] {
  return t;
}

const LLAMA_BLOCK_TEXT = "Maaf, pesan Anda terdeteksi tidak aman untuk diproses otomatis. Saya alihkan ke CS manusia.";

/** Gerbang Llama Guard (dimulai paralel di guard_in). true = aman/fail-open. */
async function llamaGate(bag: RunBag): Promise<boolean> {
  const lg = await bag.llamaGuard;
  return !lg?.blocked;
}

// --- NODE: guard_in — aturan deterministik -> redaksi PII -> (paralel) Llama Guard + RAG + intent cadangan ---
async function nodeGuardIn(state: State, config: any): Promise<Partial<State>> {
  const { env, trace, bag }: RunConfigurable = config.configurable;
  const span = trace?.span("guard_in", { textLen: state.userText.length });
  const startedAt = since(state);
  const rules: XrayGuardRule[] = [];
  const blockWith = (layer: string, rule: string, detail: string, finalText: string, technique: XrayTechnique[]) => {
    rules.push({ rule, result: "blok", detail });
    audit(bag, env.DB, state.sessionId, "system", "guard_block", { layer, reason: detail });
    span?.end({ blocked: true, layer, technique, guards: rules }, "WARNING");
    return { blockedByGuard: layer, instantDelivery: true, finalText };
  };

  const heur = heuristicInjectionCheck(state.userText);
  if (heur.blocked) {
    return blockWith("injection", "pola prompt injection", (heur.reason ?? "").slice(0, 90), "Maaf, pesan Anda terdeteksi mengandung instruksi yang tidak dapat saya proses demi keamanan akun Anda. Jika ini kesalahan, silakan ajukan pertanyaan dengan kalimat lain, atau saya alihkan ke CS.", techs(TECH.injectionRegex));
  }
  rules.push({ rule: "pola prompt injection (regex)", result: "lolos" });

  // FIX (temuan QA M2): ubah/hapus riwayat transaksi ditolak DETERMINISTIK (tidak ada tool UPDATE/DELETE).
  const writeAbuse = checkDataIntegrityAbuse(state.userText);
  if (writeAbuse.blocked) {
    return blockWith("tool_policy", "kebijakan tool: ubah/hapus data", (writeAbuse.reason ?? "").slice(0, 90), "Maaf, saya TIDAK BISA menghapus atau mengubah riwayat transaksi/status pembayaran Anda — sistem ini sengaja tidak memiliki tool untuk itu (integritas data: audit log append-only, tidak ada update/delete langsung ke data transaksi, lihat kebijakan integritas data kami). Kalau Anda keberatan dengan status keterlambatan/denda, saya bisa catat sebagai pengaduan untuk ditinjau CS/tim kredit — bukan diubah otomatis. Mau saya bantu buatkan pengaduan itu?", techs(TECH.injectionRegex, TECH.dataIntegrity));
  }
  rules.push({ rule: "kebijakan tool: ubah/hapus data", result: "lolos" });

  const piiExfil = checkThirdPartyPiiRequest(state.userText);
  if (piiExfil.blocked) {
    return blockWith("privacy_exfil", "privasi pihak ketiga", (piiExfil.reason ?? "").slice(0, 90), "Maaf, saya tidak bisa memberikan data pribadi orang lain (NIK, nomor HP, alamat, atau rekening), apa pun keperluannya. Setiap mitra hanya bisa mengakses datanya sendiri setelah verifikasi. Untuk kebutuhan internal/audit, silakan ajukan lewat jalur resmi tim yang berwenang.", techs(TECH.injectionRegex, TECH.dataIntegrity, TECH.privacyExfil));
  }
  rules.push({ rule: "privasi pihak ketiga", result: "lolos" });

  const scope = checkScope(state.userText);
  if (!scope.inScope) {
    return blockWith("scope", "cakupan topik", scope.reason ?? "", "Maaf, saya hanya dapat membantu hal-hal terkait layanan Modal Mitra Contoh (pinjaman, majelis, pendanaan, pengaduan, data pribadi). Untuk topik ini saya tidak bisa membantu.", techs(TECH.injectionRegex, TECH.scope));
  }
  rules.push({ rule: "cakupan topik", result: "lolos" });

  const { redacted, matches } = redactPII(state.userText);
  rules.push({ rule: "redaksi PII", result: matches.length ? "ubah" : "lolos", detail: matches.length ? `${matches.length} nilai → token (${[...new Set(matches.map((m) => m.type))].join(", ")})` : "tidak ada PII" });
  if (matches.length > 0) audit(bag, env.DB, state.sessionId, "system", "pii_redacted", { count: matches.length, types: matches.map((m) => m.type) });

  // Mulai PARALEL (feat/latency-xray): Llama Guard, retrieval RAG (ditunggu di tools), intent cadangan
  // (ditunggu di route_intent, hanya bila aturan regex = "lain"). Llama Guard TIDAK ditunggu di sini:
  // verdict-nya menjadi GERBANG sebelum (a) aksi tulis apa pun (tiket/DSR/restru) dan (b) teks pertama
  // tampil ke pengguna (StreamGuard.gate) — jadi model boleh mulai menulis, tapi tidak ada yang tampil
  // atau tertulis ke D1 sebelum pesan dinyatakan aman. Retrieval memakai teks TEREDAKSI.
  const lgStart = Date.now();
  const lgSpan = trace?.span("llama_guard", { parallel: true });
  bag.llamaGuard = withTimeout(
    llamaGuardCheck(env.AI, env.MODEL_GUARD, redacted).then((r) => ({ ...r, ms: Date.now() - lgStart })),
    LLAMA_GUARD_TIMEOUT_MS,
    { blocked: false, source: "none" as const, reason: `timeout ${LLAMA_GUARD_TIMEOUT_MS}ms → fail-open ke aturan`, ms: LLAMA_GUARD_TIMEOUT_MS },
  ).then((lg) => {
    const call: XrayCall = { kind: "model", name: env.MODEL_GUARD.replace(/^@cf\//, ""), args: "pesan teredaksi", result: lg.blocked ? `unsafe → blok (${lg.reason?.slice(0, 40)})` : lg.source === "none" ? lg.reason ?? "tidak tersedia → fail-open" : lg.reason ? `observasi: ${lg.reason}` : "safe", ms: lg.ms, atMs: startedAt };
    const rule: XrayGuardRule = lg.blocked ? { rule: "Llama Guard 3", result: "blok", detail: lg.reason?.slice(0, 80) } : { rule: "Llama Guard 3", result: lg.source === "none" ? "lewati" : "lolos", detail: lg.source === "none" ? "fail-open (aturan deterministik tetap berlaku)" : undefined };
    if (lg.blocked) audit(bag, env.DB, state.sessionId, "system", "guard_block", { layer: "llama_guard", reason: lg.reason });
    lgSpan?.end({ blocked: lg.blocked, layer: lg.blocked ? "llama_guard" : undefined, technique: techs(TECH.llamaGuard, TECH.parallel), calls: [call], guards: [rule], note: "berjalan paralel dengan RAG & LLM; teks pertama dan aksi tulis menunggu verdict ini" }, lg.blocked ? "WARNING" : "DEFAULT");
    return lg;
  });
  bag.retrieval = retrieve(env.AI, env.VECTORIZE, env.EMBED_MODEL, redacted);
  const ruleIntent = classifyIntent(state.userText, state.persona as Persona);
  if (ruleIntent === "lain" && redacted.trim().split(/\s+/).length >= 4) {
    bag.llmIntent = classifyIntentFast(env.AI, env.KENARI_API_KEY, redacted, env.KENARI_CHAT_MODEL, INTENT_LLM_BUDGET_MS);
  }
  rules.push({ rule: "Llama Guard 3", result: "catat", detail: "berjalan paralel — teks pertama & aksi tulis menunggu verdict" });

  span?.end({
    blocked: false,
    piiRedactedCount: matches.length,
    technique: techs(TECH.injectionRegex, TECH.dataIntegrity, TECH.privacyExfil, TECH.scope, TECH.piiRedaction, TECH.parallel),
    guards: rules,
    parallel: ["llama_guard", "rag_retrieval", ...(bag.llmIntent ? ["intent_llm"] : [])],
  });
  return { redacted, vaultEntries: matches.map((m) => [m.token, m.original] as [string, string]) };
}

// --- NODE: verify_identity — auto-verify dua faktor bila pesan memuat ID + tanggal lahir ---
const BIRTH_RE = [/\b\d{4}-\d{2}-\d{2}\b/, /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/, /\b\d{1,2}\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}\b/i];

async function nodeVerifyIdentity(state: State, config: any): Promise<Partial<State>> {
  const { env, trace, bag }: RunConfigurable = config.configurable;
  const span = trace?.span("verify_identity", {});
  const technique = techs(TECH.autoVerify, TECH.piiRedaction);
  if (state.verifiedActorId) {
    span?.end({ skipped: true, reason: "already_verified", verified: true, technique, note: "sudah terverifikasi di giliran sebelumnya" });
    return {};
  }
  const pinjamanMatch = state.persona === "mitra" ? state.userText.match(/\bMMK-\d{6}\b/i) : null;
  const pendanaMatch = state.persona === "pendana" ? state.userText.match(/\bPND-\d{4}\b/i) : null;
  const birthMatch = BIRTH_RE.map((re) => state.userText.match(re)).find(Boolean) ?? null;
  if (!(pinjamanMatch || pendanaMatch) || !birthMatch) {
    span?.end({ skipped: true, reason: "no_pattern", technique, note: "pesan tidak memuat pasangan ID + tanggal lahir" });
    return {};
  }
  const tool: ToolName = pinjamanMatch ? "verify_mitra" : "verify_pendana";
  const args = pinjamanMatch
    ? { pinjaman_no: pinjamanMatch[0].toUpperCase(), birth_date: normalizeBirthDate(birthMatch[0]) }
    : { pendana_id: pendanaMatch![0].toUpperCase(), birth_date: normalizeBirthDate(birthMatch[0]) };
  const t0 = Date.now();
  const at = since(state);
  const verifyResult = await executeTool(env.DB, tool, args, { verifiedActorId: null, actorType: null, sessionId: state.sessionId });
  const call: XrayCall = { kind: "tool", name: tool, args: maskArgs(args), result: summarizeToolResult(tool, verifyResult), ms: Date.now() - t0, atMs: at };
  if (verifyResult.ok && verifyResult.data?.verified) {
    audit(bag, env.DB, state.sessionId, "system", "tool_call", { tool, ok: true, auto: true });
    const actorId = String(verifyResult.data.actor_id);
    span?.end({ verified: true, technique, calls: [call] });
    return {
      verifiedActorId: actorId,
      allowedIds: [...new Set([...state.allowedIds, actorId.toUpperCase(), ...(pinjamanMatch ? [pinjamanMatch[0].toUpperCase()] : [])])],
      toolCallsMade: [...state.toolCallsMade, { tool, ok: true }],
    };
  }
  audit(bag, env.DB, state.sessionId, "system", "tool_call", { tool, ok: false, auto: true });
  span?.end({ verified: false, technique, calls: [call] });
  return { toolCallsMade: [...state.toolCallsMade, { tool, ok: false }] };
}

// --- NODE: route_intent — intent (aturan + cadangan LLM) + HITL + aksi kepatuhan deterministik ---
async function nodeRouteIntent(state: State, config: any): Promise<Partial<State>> {
  const { env, trace, bag }: RunConfigurable = config.configurable;
  const span = trace?.span("route_intent", {});
  const technique: XrayTechnique[] = [TECH.intentRules];
  const calls: XrayCall[] = [];
  let intent: Intent = classifyIntent(state.userText, state.persona as Persona);
  let intentSource = "aturan regex";
  if (intent === "lain" && bag.llmIntent) {
    const at = since(state);
    const llm = await bag.llmIntent;
    technique.push(TECH.intentLLM);
    calls.push({ kind: "model", name: llm ? (llm.model.startsWith("@cf/") ? llm.model.replace(/^@cf\//, "") : `kenari:${llm.model}`) : "Workers AI 8B ∥ Kenari (lomba)", args: "pesan teredaksi + 3 contoh few-shot", result: llm ? `intent: ${llm.intent}` : `tidak ada jawaban valid dalam ${INTENT_LLM_BUDGET_MS} ms → tetap 'lain'`, ms: llm?.ms ?? INTENT_LLM_BUDGET_MS, tokIn: llm?.usage?.input, tokOut: llm?.usage?.output, atMs: at });
    if (llm && llm.intent !== "lain") {
      // Intent kepatuhan mitra-only tetap tunduk pada persona (sama seperti aturan).
      const mitraOnly = llm.intent === "keterlambatan" || llm.intent === "pengajuan";
      if (!mitraOnly || state.persona === "mitra") {
        intent = llm.intent;
        intentSource = "LLM few-shot (aturan = lain)";
      }
    }
  }
  const explicitHumanRequest = /\b(bicara dengan (manusia|cs|petugas)|minta cs|mau cs|(sambung(in|kan)?|connect|m(i|n)ta|hubungkan)\b.{0,15}\b(cs|petugas|manusia))\b/i.test(state.userText.toLowerCase());
  const hitl = detectHitl(state.userText, state.failedUnderstandingCount, explicitHumanRequest);
  technique.push(TECH.hitl);

  // Aksi TULIS (tiket/DSR/restru) hanya setelah verdict Llama Guard aman.
  const willWrite = intent === "pengaduan" || intent === "hak_data" || (intent === "keterlambatan" && state.persona === "mitra" && !!state.verifiedActorId);
  if (willWrite && !(await llamaGate(bag))) {
    span?.end({ intent, intentSource, blocked: true, layer: "llama_guard", technique, calls, note: "aksi tulis dibatalkan: Llama Guard menandai pesan tidak aman" }, "WARNING");
    return { intent, blockedByGuard: "llama_guard", instantDelivery: true, finalText: LLAMA_BLOCK_TEXT };
  }

  let autoTicket: any = null;
  const extraToolCalls: { tool: string; ok: boolean }[] = [];
  const runAction = async (tool: ToolName, args: Record<string, any>, actorType: "mitra" | "pendana") => {
    const t0 = Date.now();
    const at = since(state);
    const result = await executeTool(env.DB, tool, args, { verifiedActorId: state.verifiedActorId, actorType, sessionId: state.sessionId });
    // Teks bebas (subjek/deskripsi/alasan) TIDAK ditampilkan — hanya kunci + panjang; field enum apa adanya.
    const shown = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.length > 24 ? `(teks ${v.length} karakter)` : v]));
    calls.push({ kind: "tool", name: tool, args: maskArgs(shown), result: summarizeToolResult(tool, result), ms: Date.now() - t0, atMs: at });
    return result;
  };
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
    const result = await runAction("create_complaint_ticket", { category, severity: ticketSeverity, subject: state.userText.slice(0, 100), description: state.userText }, state.persona === "pendana" ? "pendana" : "mitra");
    if (result.ok) {
      autoTicket = result.data;
      extraToolCalls.push({ tool: "create_complaint_ticket", ok: true });
      audit(bag, env.DB, state.sessionId, "system", "tool_call", { tool: "create_complaint_ticket", ok: true, auto: true });
    }
  }

  if (hitl.shouldHandoff) {
    audit(bag, env.DB, state.sessionId, "system", "handoff", { reason: hitl.reason, severity: hitl.severity, ticket_id: autoTicket?.ticket_id ?? null });
    const sev = hitl.severity === "critical" ? "Permintaan Anda sangat penting dan langsung kami eskalasi dengan prioritas tinggi." : "Baik, saya alihkan percakapan ini ke tim CS kami.";
    const ticketLine = autoTicket ? ` Pengaduan Anda sudah tercatat dengan nomor tiket ${autoTicket.ticket_id}.` : "";
    const text = `${sev}${ticketLine} Mohon tunggu sebentar, CS kami akan segera membantu Anda.`;
    if (calls.some((c) => c.kind === "tool")) technique.push(TECH.deterministicAction);
    span?.end({ intent, intentSource, handoff: true, severity: hitl.severity, hitlReason: hitl.reason, technique, calls });
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
    const requestType = /hapus/i.test(state.userText) ? "delete" : /koreksi|perbaiki|ubah/i.test(state.userText) ? "correction" : /keberatan|automated|otomatis/i.test(state.userText) ? "object_automated_decision" : "access";
    const result = await runAction("create_dsr_request", { request_type: requestType, detail: state.userText.slice(0, 500) }, state.persona === "pendana" ? "pendana" : "mitra");
    if (result.ok) {
      autoDsr = result.data;
      extraToolCalls.push({ tool: "create_dsr_request", ok: true });
      audit(bag, env.DB, state.sessionId, "system", "tool_call", { tool: "create_dsr_request", ok: true, auto: true });
    }
  }

  // FIX BLOCKER (temuan QA #2): restrukturisasi hanya dibuat bila diminta EKSPLISIT atau konfirmasi
  // singkat atas tawaran AI sebelumnya; idempotensi juga ditegakkan di executeTool.
  let autoRestru: any = null;
  if (intent === "keterlambatan" && state.persona === "mitra" && state.verifiedActorId) {
    const lastAssistantText = [...state.history].reverse().find((h) => h.role === "assistant")?.text ?? "";
    const offeredKeringanan = /keringanan|restrukturisasi|perpanjang(an)?/i.test(lastAssistantText);
    const explicitRestruRequest = /restrukturisasi|keringanan|perpanjang|ajukan/i.test(state.userText);
    const briefConfirm = /^\s*(iya|ya|yap|oke|ok|boleh|setuju|lanjut(kan)?)\b/i.test(state.userText.trim());
    if (explicitRestruRequest || (briefConfirm && offeredKeringanan)) {
      const reason = explicitRestruRequest ? state.userText.slice(0, 500) : `Konfirmasi atas tawaran sebelumnya ("${lastAssistantText.slice(0, 150)}") — balasan mitra: "${state.userText.slice(0, 150)}"`;
      const result = await runAction("create_restructuring_request", { reason }, "mitra");
      if (result.ok) {
        autoRestru = result.data;
        extraToolCalls.push({ tool: "create_restructuring_request", ok: true });
        audit(bag, env.DB, state.sessionId, "system", "tool_call", { tool: "create_restructuring_request", ok: true, auto: true, idempotent: result.data?.alreadyExisted ?? false });
      }
    }
  }
  if (calls.some((c) => c.kind === "tool")) technique.push(TECH.deterministicAction);

  span?.end({ intent, intentSource, handoff: false, technique, calls });
  return { intent, autoTicket, autoDsr, autoRestru, toolCallsMade: [...state.toolCallsMade, ...extraToolCalls] };
}

/** Tool deterministik yang PASTI dibutuhkan intent ini (dipanggil kode, bukan dipilih LLM). */
function plannedTools(state: State, verifiedActorId: string | null): { tool: ToolName; args: Record<string, any> }[] {
  if (!verifiedActorId) return [];
  const t = state.userText.toLowerCase();
  if (state.persona === "mitra") {
    const wantsMajelis = /majelis|pertemuan|jadwal|petugas/.test(t);
    const wantsAngsuran = /angsuran|cicilan|sisa|tagihan|jatuh tempo|bayar|telat|setor|denda/.test(t) || state.intent === "keterlambatan";
    const out: { tool: ToolName; args: Record<string, any> }[] = [];
    if (state.intent === "keterlambatan") out.push({ tool: "get_angsuran", args: { only_unpaid: true } });
    else if (wantsAngsuran || (state.intent === "akun" && !wantsMajelis)) out.push({ tool: "get_angsuran", args: { only_unpaid: false } });
    if (wantsMajelis) out.push({ tool: "get_majelis_info", args: {} });
    return out;
  }
  if (state.persona === "pendana" && (state.intent === "akun" || /portofolio|portfolio|pendanaan saya|dana saya|pencairan/.test(t))) {
    return [{ tool: "get_portofolio", args: {} }];
  }
  return [];
}

// --- NODE: tools — RAG (sudah berjalan sejak guard_in) + prefetch tool deterministik + ReAct bila perlu + jawaban streaming ---
async function nodeTools(state: State, config: any): Promise<Partial<State>> {
  const { env, trace, bag }: RunConfigurable = config.configurable;
  const span = trace?.span("tools", { intent: state.intent });
  const allowedIds = new Set(state.allowedIds);
  const vault = new Map(state.vaultEntries);
  let verifiedActorId = state.verifiedActorId;
  const calls: XrayCall[] = [];
  const technique: XrayTechnique[] = [];
  const toolCallsMade: { tool: string; ok: boolean }[] = [];
  const actorType: "mitra" | "pendana" | null = state.persona === "pendana" ? "pendana" : state.persona === "mitra" ? "mitra" : null;

  // 1) RAG — dimulai paralel di guard_in.
  const ragWaitAt = since(state);
  const rag = await (bag.retrieval ?? retrieve(env.AI, env.VECTORIZE, env.EMBED_MODEL, state.redacted));
  const chunks = rag.chunks;
  const retrievedIds = new Set(chunks.map((c) => c.id.toLowerCase()));
  technique.push(rag.method === "vector" ? TECH.vectorRag : TECH.bm25);
  calls.push({ kind: "vector", name: rag.method === "vector" ? `${env.EMBED_MODEL.replace(/^@cf\//, "")} + Vectorize` : "BM25 lokal (fallback)", args: `top-k 6, ambang ${rag.method === "vector" ? "0.45" : "1.5"}`, result: `${chunks.length}/${rag.considered.length} dokumen lolos ambang${rag.fallbackReason ? ` · fallback: ${rag.fallbackReason}` : ""}`, ms: rag.ms, atMs: Math.max(0, ragWaitAt - rag.ms) });
  bag.ragDetail = {
    method: rag.method,
    // Bukan teks kueri (review Opus P2: nama/alamat/tanggal format tak dikenal bisa lolos redaksi) —
    // hanya panjang + jenis token redaksi yang ada.
    query: `pesan teredaksi (${state.redacted.length} karakter${(state.redacted.match(/\[[A-Z_]+_\d+\]/g) ?? []).length ? `, token: ${[...new Set((state.redacted.match(/\[([A-Z_]+)_\d+\]/g) ?? []).map((t) => t.replace(/_\d+\]$/, "]")))].join(" ")}` : ""})`,
    embedMs: rag.embedMs,
    queryMs: rag.queryMs,
    ms: rag.ms,
    waitedMs: since(state) - ragWaitAt,
    docs: rag.considered.map((d) => ({ id: d.id, score: d.score, kept: retrievedIds.has(d.id.toLowerCase()) })),
  };
  audit(bag, env.DB, state.sessionId, "system", "retrieve", { query_redacted: state.redacted, result_ids: [...retrievedIds], count: chunks.length, method: rag.method });
  const usedRag = chunks.length > 0;

  // 2) Prefetch tool deterministik (paralel satu sama lain).
  const planned = plannedTools(state, verifiedActorId);
  const toolData: string[] = [];
  if (planned.length > 0) {
    technique.push(TECH.toolPrefetch);
    await Promise.all(
      planned.map(async ({ tool, args }) => {
        const t0 = Date.now();
        const at = since(state);
        const result = await executeTool(env.DB, tool, args, { verifiedActorId, actorType, sessionId: state.sessionId });
        calls.push({ kind: "tool", name: tool, args: maskArgs(args), result: summarizeToolResult(tool, result), ms: Date.now() - t0, atMs: at });
        toolCallsMade.push({ tool, ok: result.ok });
        audit(bag, env.DB, state.sessionId, "ai", "tool_call", { tool, ok: result.ok, prefetch: true });
        if (tool === "get_angsuran" && result.ok) for (const row of result.data?.angsuran ?? []) allowedIds.add(String(row.pinjaman_no).toUpperCase());
        if (tool === "get_portofolio" && result.ok) for (const row of result.data?.pendanaan ?? []) allowedIds.add(String(row.pendanaan_id).toUpperCase());
        toolData.push(wrapAsData(`hasil_tool:${tool}`, JSON.stringify(result)));
      }),
    );
  }

  let ragContext = formatChunksAsContext(chunks);
  if (state.autoTicket) ragContext += `\n---\n${wrapAsData("tiket_pengaduan_otomatis", JSON.stringify(state.autoTicket))}\nSistem sudah mencatat pengaduan ini sebagai tiket ${state.autoTicket.ticket_id} dengan tenggat ${state.autoTicket.sla_due_at}. Sebutkan nomor tiket dan tenggat ini di jawaban Anda.`;
  if (state.autoDsr) ragContext += `\n---\n${wrapAsData("dsr_otomatis", JSON.stringify(state.autoDsr))}\nSistem sudah mencatat permintaan hak data ini sebagai ${state.autoDsr.dsr_id}. Jelaskan bahwa permintaan TIDAK dieksekusi otomatis dan akan ditinjau tim berwenang, sebutkan nomor ${state.autoDsr.dsr_id}.`;
  if (state.autoRestru) ragContext += `\n---\n${wrapAsData("restrukturisasi_otomatis", JSON.stringify(state.autoRestru))}\nSistem sudah mencatat permintaan restrukturisasi/keringanan ini sebagai ${state.autoRestru.restru_id}. Jelaskan bahwa ini akan ditinjau petugas lapangan/tim kredit, TIDAK ADA keputusan/jaminan otomatis, sebutkan nomor ${state.autoRestru.restru_id}.`;
  technique.push(TECH.spotlighting);

  // Guard streaming dibuat SEKARANG (dipakai jalur stream maupun ReAct) — guard_out span dimulai di
  // sini karena pengecekan berjalan bersamaan dengan generasi (waterfall X-Ray menampilkan overlap).
  bag.guardOutSpan = trace?.span("guard_out", { mode: "streaming_per_kalimat" });
  bag.guardOutStartedAt = since(state);
  const sink = bag.sink;
  const citationRelevant = usedRag && state.intent !== "akun";
  bag.streamGuard = new StreamGuard({
    vault,
    allowedIds: () => allowedIds,
    retrievedIds: () => retrievedIds,
    citationRequired: () => citationRelevant,
    emit: async (t) => {
      if (bag.firstTokenAt === undefined) bag.firstTokenAt = Date.now();
      await sink?.text(t);
    },
    replace: async (t, reason) => sink?.replace(t, reason),
    parseJson: (raw) => extractAnswerFallback(raw),
    gate: () => llamaGate(bag),
  });

  // 3) ReAct HANYA bila LLM perlu memilih tool sendiri: identitas belum terverifikasi tapi pesan
  //    menyebut nomor pinjaman/ID pendana (auto-verify gagal pola, mis. tanggal lahir informal/hilang).
  const needsReact = !verifiedActorId && /\[(PINJAMAN|PENDANA_ID)_\d+\]/.test(state.redacted);
  const react: XrayReactStep[] = [];
  let modelUsed = "none";
  let streamInfo: Record<string, unknown> | undefined;

  if (needsReact && !(await llamaGate(bag))) {
    bag.guardOutSpan?.end({ skipped: true, reason: "Llama Guard memblokir sebelum ReAct" });
    bag.guardOutSpan = undefined;
    span?.end({ blocked: true, layer: "llama_guard", technique, calls, rag: bag.ragDetail }, "WARNING");
    return { blockedByGuard: "llama_guard", instantDelivery: true, finalText: LLAMA_BLOCK_TEXT, retrievedIds: [...retrievedIds], usedRag };
  }
  if (needsReact) {
    technique.push(TECH.react);
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(state.persona as Persona, verifiedActorId, state.styleInstruction, "json") },
      ...state.history.slice(-10).map((h): ChatMessage =>
        h.role === "user" ? { role: "user", content: maskPIIForHistory(h.text, true) } : { role: "assistant", content: JSON.stringify({ type: "final_answer", text: maskPIIForHistory(h.text, false), citations: [] }) },
      ),
      { role: "user", content: buildUserTurn(state.redacted, wrapAsData("konteks_rag", ragContext)) },
    ];
    let finalRaw = "";
    for (let step = 0; step < MAX_STEPS; step++) {
      const at = since(state);
      const llmRes = await callChatModel(env.AI, env.MODEL_PRIMARY, messages, { kenariModel: env.KENARI_CHAT_MODEL, max_tokens: 700 }, env.KENARI_API_KEY);
      modelUsed = llmRes.modelUsed;
      calls.push({ kind: "model", name: llmRes.modelUsed, args: `ReAct langkah ${step + 1} (protokol JSON)`, result: llmRes.text ? "balasan diterima" : "kosong", ms: llmRes.ms, tokIn: llmRes.usage?.input, tokOut: llmRes.usage?.output, atMs: at });
      audit(bag, env.DB, state.sessionId, "ai", "llm_call", { step, model: llmRes.modelUsed, degraded: llmRes.degraded });
      trace?.generation(`llm_call_step_${step}`, llmRes.modelUsed, messages[messages.length - 1], llmRes.text, llmRes.usage);

      const parsed = safeParseAgentJson(llmRes.text);
      if (!parsed || parsed.type !== "tool_call") {
        react.push({ step: step + 1, action: "final_answer", observation: "jawaban akhir disusun", ms: llmRes.ms });
        finalRaw = llmRes.text;
        break;
      }
      const toolName = parsed.tool as ToolName;
      const def = TOOL_REGISTRY[toolName];
      const thought = sanitizeThought(parsed.thought);
      if (!def) {
        react.push({ step: step + 1, thought, action: safeToolName(parsed.tool, TOOL_REGISTRY), observation: "tool tidak dikenal", ms: llmRes.ms });
        messages.push({ role: "assistant", content: llmRes.text });
        messages.push({ role: "user", content: buildToolResultTurn(parsed.tool ?? "unknown", JSON.stringify({ ok: false, error: "tool tidak dikenal" })) });
        continue;
      }
      const resolvedArgs = normalizeToolArgs(resolveTokens(parsed.args ?? {}, vault));
      const argsParse = def.schema.safeParse(resolvedArgs);
      if (!argsParse.success) {
        audit(bag, env.DB, state.sessionId, "system", "tool_call_invalid", { tool: toolName, issues: argsParse.error.issues });
        react.push({ step: step + 1, thought, action: toolName, args: maskArgs(parsed.args), observation: "argumen tidak valid (skema Zod)", ms: llmRes.ms });
        messages.push({ role: "assistant", content: llmRes.text });
        messages.push({ role: "user", content: buildToolResultTurn(toolName, JSON.stringify({ ok: false, error: "argumen tidak valid" })) });
        continue;
      }
      let result: { ok: boolean; data?: any; error?: string };
      const t0 = Date.now();
      if (toolName === "create_complaint_ticket" && state.autoTicket) result = { ok: true, data: state.autoTicket };
      else if (toolName === "create_dsr_request" && state.autoDsr) result = { ok: true, data: state.autoDsr };
      else if (toolName === "create_restructuring_request" && state.autoRestru) result = { ok: true, data: state.autoRestru };
      else result = await executeTool(env.DB, toolName, argsParse.data as any, { verifiedActorId, actorType, sessionId: state.sessionId });
      const toolMs = Date.now() - t0;
      calls.push({ kind: "tool", name: toolName, args: maskArgs(parsed.args), result: summarizeToolResult(toolName, result), ms: toolMs, atMs: since(state) - toolMs });
      react.push({ step: step + 1, thought, action: toolName, args: maskArgs(parsed.args), observation: summarizeToolResult(toolName, result), ms: llmRes.ms + toolMs });
      toolCallsMade.push({ tool: toolName, ok: result.ok });
      audit(bag, env.DB, state.sessionId, "ai", "tool_call", { tool: toolName, ok: result.ok });

      if ((toolName === "verify_mitra" || toolName === "verify_pendana") && result.ok && result.data?.verified) {
        verifiedActorId = result.data.actor_id;
        allowedIds.add(String(verifiedActorId).toUpperCase());
        // FIX (temuan QA MAJOR a): emit event susulan supaya kartu Verify menunjukkan status nyata.
        trace?.span("verify_identity", { viaToolCall: true }).end({ verified: true, via: "tool_call", technique: techs(TECH.react) });
      }
      if (toolName === "handoff_to_human" && result.ok) {
        audit(bag, env.DB, state.sessionId, "system", "handoff", { reason: result.data?.reason ?? "tool_call_llm", severity: "normal", ticket_id: state.autoTicket?.ticket_id ?? null });
        const ticketLine = state.autoTicket ? ` Pengaduan Anda sudah tercatat dengan nomor tiket ${state.autoTicket.ticket_id}.` : "";
        bag.guardOutSpan?.end({ skipped: true, reason: "handoff mid-loop (teks sistem, bukan LLM)" });
        bag.guardOutSpan = undefined;
        span?.end({ handoffMidLoop: true, steps: state.toolCallsMade.length + toolCallsMade.length, technique, calls, react: { steps: react }, model: llmRes.modelUsed });
        return {
          handoffTriggered: true,
          instantDelivery: true,
          handoffReason: result.data?.reason ?? "tool_call_llm",
          handoffSeverity: "normal",
          finalText: `Baik, saya alihkan percakapan ini ke tim CS kami.${ticketLine} Mohon tunggu sebentar, CS kami akan segera membantu Anda.`,
          modelUsed: llmRes.modelUsed,
          verifiedActorId,
          allowedIds: [...allowedIds],
          toolCallsMade: [...state.toolCallsMade, ...toolCallsMade],
        };
      }
      if (toolName === "get_angsuran" && result.ok) for (const row of result.data?.angsuran ?? []) allowedIds.add(String(row.pinjaman_no).toUpperCase());
      if (toolName === "get_portofolio" && result.ok) for (const row of result.data?.pendanaan ?? []) allowedIds.add(String(row.pendanaan_id).toUpperCase());
      messages.push({ role: "assistant", content: llmRes.text });
      messages.push({ role: "user", content: buildToolResultTurn(toolName, JSON.stringify(result)) });
    }
    // Jawaban akhir ReAct sudah lengkap (JSON) -> lewat guard per kalimat yang sama, lalu tampil.
    const { text } = extractAnswerFallback(finalRaw);
    await bag.streamGuard.push(text || FALLBACK_NOT_FOUND);
  } else {
    // 4) Jalur cepat: SATU panggilan LLM streaming teks polos, tool sudah di-prefetch.
    technique.push(TECH.streamingLLM);
    const guidance = !verifiedActorId && (state.intent === "akun" || state.intent === "keterlambatan")
      ? "Identitas BELUM terverifikasi: jelaskan opsi umum dari konteks bila relevan, lalu minta nomor pinjaman + tanggal lahir untuk cek data akunnya."
      : undefined;
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(state.persona as Persona, verifiedActorId, state.styleInstruction, "stream") },
      ...state.history.slice(-10).map((h): ChatMessage => ({ role: h.role, content: maskPIIForHistory(h.text, h.role === "user") })),
      { role: "user", content: buildStreamingAnswerTurn(state.redacted, ragContext, toolData.length ? toolData.join("\n\n") : null, guidance) },
    ];
    const at = since(state);
    const raceEnabled = bag.budget.allowRace();
    const res = await streamChatModel(env.AI, env.MODEL_PRIMARY, messages, (d) => bag.streamGuard!.push(d), {
      kenariApiKey: env.KENARI_API_KEY,
      kenariModel: env.KENARI_CHAT_MODEL,
      kenariHedgeModel: env.KENARI_HEDGE_MODEL,
      hedgeAfterMs: Number(env.LLM_HEDGE_AFTER_MS ?? 1500),
      workersAfterMs: raceEnabled ? Number(env.WORKERS_AI_RACE_AFTER_MS ?? env.LLM_HEDGE_AFTER_MS ?? 1500) : -1,
      max_tokens: 700,
    });
    modelUsed = res.modelUsed;
    for (const a of res.attempts) {
      calls.push({
        kind: "model",
        name: a.provider === "kenari" ? `kenari:${a.model}` : a.model,
        args: `streaming teks · ${messages.length} pesan${a.provider === "workers_ai" ? " · hedge" : ""}`,
        result: `${a.outcome}${a.ttftMs !== undefined ? ` · token pertama ${a.ttftMs} ms` : ""}`,
        ms: a.ms,
        tokIn: a.usage?.input,
        tokOut: a.usage?.output,
        atMs: at + a.startedAtMs,
      });
    }
    const winnerAttempt = res.attempts.find((a) => a.outcome === "menang");
    const losers = res.attempts.filter((a) => a !== winnerAttempt);
    const reason = !winnerAttempt
      ? "tidak ada penyedia yang menghasilkan teks → pesan aman standar"
      : !raceEnabled && winnerAttempt.provider === "kenari"
        ? `Workers AI tidak ikut balapan: perkiraan pemakaian hari ini ${Math.round(bag.budget.used)}/${RACE_CAP} neuron (cap biaya nol)`
        : losers.length
          ? `token pertama paling cepat (${(winnerAttempt.startedAtMs ?? 0) + (winnerAttempt.ttftMs ?? 0)} ms) vs ${losers.map((l) => `${l.provider === "kenari" ? l.model : "Workers AI"}: ${l.outcome}`).join(", ")}`
          : "satu-satunya kandidat yang dijalankan (lainnya belum sempat mulai)";
    streamInfo = { ttftMs: res.ttftMs, hedged: res.hedged, winner: res.modelUsed, reason, candidates: res.candidates, workersAiBudget: { neuronsToday: Math.round(bag.budget.used), raceCap: RACE_CAP, raceEnabled } };
    audit(bag, env.DB, state.sessionId, "ai", "llm_call", { step: 0, model: res.modelUsed, degraded: res.degraded, streaming: true, hedged: res.hedged });
    trace?.generation("llm_stream_answer", res.modelUsed, messages[messages.length - 1], res.text ?? "", res.usage);
    if (!res.text) await bag.streamGuard.push(FALLBACK_NOT_FOUND);
  }

  span?.end({
    steps: state.toolCallsMade.length + toolCallsMade.length,
    model: modelUsed,
    technique,
    calls,
    rag: bag.ragDetail,
    react: needsReact ? { steps: react } : { skipped: planned.length ? `ReAct dilewati: tool yang dibutuhkan intent '${state.intent}' sudah dipanggil deterministik` : `ReAct dilewati: intent '${state.intent}' tidak butuh tool yang dipilih LLM` },
    stream: streamInfo,
  });
  return {
    modelUsed,
    verifiedActorId,
    allowedIds: [...allowedIds],
    toolCallsMade: [...state.toolCallsMade, ...toolCallsMade],
    retrievedIds: [...retrievedIds],
    usedRag,
  };
}

// --- NODE: guard_out — selesaikan guard streaming (cek akhir) + baris tiket/DSR/restru ---
async function nodeGuardOut(state: State, config: any): Promise<Partial<State>> {
  const { env, bag }: RunConfigurable = config.configurable;
  const sg = bag.streamGuard!;
  const r = await sg.finish();
  let finalText = r.text;
  const blockedByGuard = r.blockedBy === "input_unsafe" ? "llama_guard" : r.blockedBy;
  if (blockedByGuard) audit(bag, env.DB, state.sessionId, "system", "output_guard_block", { reason: blockedByGuard, replaced: r.replaced });

  // Baris sistem (bukan LLM) — dikirim sebagai potongan tambahan setelah jawaban.
  const extras: string[] = [];
  if (state.autoTicket && !finalText.includes(state.autoTicket.ticket_id)) extras.push(`\n\nPengaduan Anda telah dicatat dengan nomor tiket ${state.autoTicket.ticket_id}, akan ditindaklanjuti paling lambat ${new Date(state.autoTicket.sla_due_at).toLocaleDateString("id-ID")} sesuai SOP penanganan pengaduan kami.`);
  if (state.autoDsr && !finalText.includes(state.autoDsr.dsr_id)) extras.push(`\n\nPermintaan hak data Anda telah dicatat dengan nomor ${state.autoDsr.dsr_id}. Permintaan ini akan ditinjau oleh tim yang berwenang dan tidak dieksekusi secara otomatis.`);
  if (state.autoRestru && !finalText.includes(state.autoRestru.restru_id)) extras.push(`\n\nPermintaan restrukturisasi/keringanan Anda telah dicatat dengan nomor ${state.autoRestru.restru_id}, akan ditinjau petugas lapangan/tim kredit. Tidak ada keputusan otomatis.`);
  for (const e of extras) {
    finalText += e;
    if (bag.firstTokenAt === undefined) bag.firstTokenAt = Date.now();
    await bag.sink?.text(e);
  }
  // Bubble sudah diganti (replace) -> pengganti harus ikut memuat baris tiket/DSR/restru (review Opus).
  if (r.replaced && extras.length) await bag.sink?.replace(finalText, r.blockedBy ?? "sitasi_wajib");
  const citations = blockedByGuard ? [] : [...new Set([...finalText.matchAll(/\[([a-z0-9-]+#[a-z0-9-]+)\]/gi)].map((m) => m[1].toLowerCase()))];
  const rules: XrayGuardRule[] = [
    ...r.rules,
    ...(extras.length ? [{ rule: "baris nomor tiket/DSR/restru (teks sistem)", result: "ubah" as const, detail: `${extras.length} baris ditambahkan` }] : []),
  ];
  bag.guardOutSpan?.end(
    {
      blocked: !!blockedByGuard,
      reason: blockedByGuard,
      replaced: r.replaced,
      sentencesShown: r.sentencesShown,
      sentencesChecked: r.sentencesChecked,
      citedIds: citations,
      technique: techs(TECH.sentenceGuard, TECH.promptLeak, TECH.piiOutputScan, TECH.promiseBan, TECH.privacyGroundedness, TECH.citationValidation),
      guards: rules,
    },
    blockedByGuard ? "WARNING" : "DEFAULT",
  );
  return { finalText, citations, blockedByGuard, replaced: r.replaced, modelRefused: !blockedByGuard && looksLikeRefusal(finalText) };
}

// --- NODE: respond — kirim teks instan (blokir/handoff), tunggu antrean audit, timing ---
async function nodeRespond(state: State, config: any): Promise<Partial<State>> {
  const { env, trace, bag }: RunConfigurable = config.configurable;
  const span = trace?.span("respond", {});
  if (state.instantDelivery && state.finalText) {
    bag.firstTokenAt = Date.now();
    await bag.sink?.text(state.finalText);
  }
  await bag.llamaGuard; // (sudah selesai/≤ timeout) supaya span Llama Guard lengkap sebelum giliran ditutup
  await bag.budget.flush();
  const auditStart = Date.now();
  audit(bag, env.DB, state.sessionId, "ai", "output", { text_len: state.finalText.length, citations: state.citations, intent: state.intent });
  await bag.auditQ;
  const totalMs = Date.now() - state.turnStartedAt;
  const firstTokenMs = bag.firstTokenAt !== undefined ? bag.firstTokenAt - state.turnStartedAt : null;
  span?.end({
    totalMs,
    firstTokenMs,
    instant: state.instantDelivery,
    technique: techs(TECH.audit),
    calls: [{ kind: "db", name: "audit_log (D1, hash-chain+HMAC)", args: "antrean berurutan", result: "tersimpan", ms: Date.now() - auditStart, atMs: since(state) - (Date.now() - auditStart) }],
  });
  trace?.update({ output: { textLen: state.finalText.length, citations: state.citations, blockedByGuard: state.blockedByGuard, handoff: state.handoffTriggered } });
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
    .addConditionalEdges("route_intent", (s: State) => (s.handoffTriggered || s.blockedByGuard ? "respond" : "tools"), ["respond", "tools"])
    .addConditionalEdges("tools", (s: State) => (s.handoffTriggered || s.blockedByGuard ? "respond" : "guard_out"), ["respond", "guard_out"])
    .addEdge("guard_out", "respond")
    .addEdge("respond", END);
  return graph.compile();
}

const COMPILED_GRAPH = buildGraph();

export interface AgentTurnInput {
  sessionId: string;
  persona: Persona;
  userText: string;
  history?: { role: "user" | "assistant"; text: string }[];
  verifiedActorId: string | null;
  failedUnderstandingCount: number;
  styleInstruction?: string;
  /** Awal giliran (ms epoch) — default sekarang. ChatAgent mengisi saat pesan diterima. */
  turnStartedAt?: number;
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
  modelRefused: boolean;
  instantDelivery: boolean;
  replaced: boolean;
  timing: { firstTokenMs: number | null; totalMs: number };
}

export async function runAgentGraph(env: AgentEnvBindings, input: AgentTurnInput, trace: LangfuseTrace | null = null, sink: TurnSink | null = null): Promise<AgentTurnOutput> {
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
    modelRefused: false,
    blockedByGuard: undefined,
    instantDelivery: false,
    replaced: false,
    handoffTriggered: false,
    handoffReason: undefined,
    handoffSeverity: "normal",
    usedRag: false,
    retrievedIds: [],
    turnStartedAt: input.turnStartedAt ?? Date.now(),
    firstTokenMs: null,
    totalMs: 0,
  };
  // Anggaran neuron Workers AI harian (cap biaya nol, aiBudget.ts): dibaca sekali per giliran; binding AI
  // dibungkus supaya SETIAP panggilan dicek & dicatat. Balapan Qwen + klasifikasi cadangan = opsional.
  const budget = new WorkersAiBudget(env.DB);
  await budget.load();
  const meteredEnv: AgentEnvBindings = { ...env, AI: meteredAi(env.AI, budget, new Set([env.MODEL_PRIMARY, "@cf/meta/llama-3.1-8b-instruct-fast"])) };
  const bag: RunBag = { sink, auditQ: Promise.resolve(), budget };

  const final = (await COMPILED_GRAPH.invoke(initial, { configurable: { env: meteredEnv, trace, bag } })) as State;

  return {
    answerText: final.finalText,
    citations: final.citations,
    intent: final.intent as Intent,
    handoff: { triggered: final.handoffTriggered, reason: final.handoffReason, severity: final.handoffSeverity },
    verifiedActorId: final.verifiedActorId,
    toolCallsMade: final.toolCallsMade,
    modelUsed: final.modelUsed,
    blockedByGuard: final.blockedByGuard,
    modelRefused: final.modelRefused,
    instantDelivery: final.instantDelivery,
    replaced: final.replaced,
    timing: { firstTokenMs: final.firstTokenMs, totalMs: final.totalMs },
  };
}

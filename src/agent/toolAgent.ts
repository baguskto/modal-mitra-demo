import { redactPII, resolveTokens, resolveLeakedTokensInText } from "../guards/pii";
import { heuristicInjectionCheck, llamaGuardCheck, wrapAsData } from "../guards/injection";
import { checkScope } from "../guards/scope";
import { checkOutput, checkCitationsGrounded, checkMemberPrivacyLeak, FALLBACK_NOT_FOUND } from "../guards/output";
import { classifyIntent, detectHitl, type Intent, type Persona } from "./router";
import { retrieve, formatChunksAsContext, type RetrievedChunk } from "./rag";
import { buildSystemPrompt, buildUserTurn, buildToolResultTurn } from "./prompts";
import { callChatModel, type ChatMessage } from "./llm";
import { TOOL_REGISTRY, normalizeToolArgs, type ToolName } from "../tools/schemas";
import { executeTool } from "../tools/execute";
import { appendAuditLog } from "../obs/audit";

export interface AgentEnvBindings {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DB: D1Database;
  MODEL_PRIMARY: string;
  MODEL_GUARD: string;
  EMBED_MODEL: string;
}

export interface AgentTurnInput {
  sessionId: string;
  persona: Persona;
  userText: string;
  verifiedActorId: string | null;
  failedUnderstandingCount: number;
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
  timing: { firstTokenMs: number | null; totalMs: number };
}

// 3 sempat terlalu kecil untuk alur verify -> lookup -> final_answer (3 langkah pas-pasan, gagal
// jika LLM butuh 1 langkah tambahan mis. verify -> get_majelis_info -> get_angsuran -> final_answer).
// Dinaikkan dengan margin agar alur akun multi-tool tidak jatuh ke fallback "tidak ditemukan".
const MAX_STEPS = 6;
const NOOP_TOKEN_SINK: (token: string) => void = () => {};

/**
 * Relay teks akhir (SUDAH lolos guard) ke pengguna per potongan kata dengan jeda kecil, sehingga
 * tampil "mengalir" di UI real-time (WS) tanpa bergantung pada streaming token mentah dari model
 * (lihat catatan di runAgentTurn soal bug streaming Workers AI untuk model ini). Jalur HTTP non-WS
 * (onToken default/noop, dipakai eval) tidak menunggu jeda apa pun -> tidak menambah latensi.
 */
async function relayFinalText(text: string, onToken: (token: string) => void): Promise<void> {
  if (!text) return;
  if (onToken === NOOP_TOKEN_SINK) {
    onToken(text);
    return;
  }
  const chunks = text.match(/\S+\s*|\s+/g) ?? [text];
  for (const chunk of chunks) {
    onToken(chunk);
    await new Promise((resolve) => setTimeout(resolve, 18));
  }
}

export async function runAgentTurn(
  env: AgentEnvBindings,
  input: AgentTurnInput,
  onToken: (token: string) => void = NOOP_TOKEN_SINK,
): Promise<AgentTurnOutput> {
  const turnStartedAt = Date.now();
  const { sessionId, userText, persona } = input;
  let verifiedActorId = input.verifiedActorId;
  const toolCallsMade: { tool: string; ok: boolean }[] = [];
  const allowedIds = new Set<string>(); // id pinjaman/pendanaan yang BOLEH disebut di jawaban turn ini (groundedness privasi antar-majelis)
  if (verifiedActorId) allowedIds.add(verifiedActorId.toUpperCase());

  // --- GUARD 1: injection (heuristik + Llama Guard lapis kedua, fail-open ke heuristik) ---
  const heur = heuristicInjectionCheck(userText);
  if (heur.blocked) {
    await appendAuditLog(env.DB, sessionId, "system", "guard_block", { layer: "injection_heuristic", reason: heur.reason });
    return emptyBlockedResult("Maaf, pesan Anda terdeteksi mengandung instruksi yang tidak dapat saya proses demi keamanan akun Anda. Jika ini kesalahan, silakan ajukan pertanyaan dengan kalimat lain, atau saya alihkan ke CS.", "injection", turnStartedAt, verifiedActorId);
  }
  // --- PII redaction sebelum apapun (termasuk Llama Guard) melihat teks ---
  const { redacted, matches } = redactPII(userText);
  const vault = new Map(matches.map((m) => [m.token, m.original] as const));
  if (matches.length > 0) {
    await appendAuditLog(env.DB, sessionId, "system", "pii_redacted", { count: matches.length, types: matches.map((m) => m.type) });
  }

  const guardCheck = await llamaGuardCheck(env.AI, env.MODEL_GUARD, redacted);
  if (guardCheck.blocked) {
    await appendAuditLog(env.DB, sessionId, "system", "guard_block", { layer: "llama_guard", reason: guardCheck.reason });
    return emptyBlockedResult("Maaf, pesan Anda terdeteksi tidak aman untuk diproses otomatis. Saya alihkan ke CS manusia.", "llama_guard", turnStartedAt, verifiedActorId);
  }

  // --- GUARD 2: scope ---
  const scope = checkScope(userText);
  if (!scope.inScope) {
    await appendAuditLog(env.DB, sessionId, "system", "guard_block", { layer: "scope", reason: scope.reason });
    return emptyBlockedResult("Maaf, saya hanya dapat membantu hal-hal terkait layanan Modal Mitra Contoh (pinjaman, majelis, pendanaan, pengaduan, data pribadi). Untuk topik ini saya tidak bisa membantu.", "scope", turnStartedAt, verifiedActorId);
  }

  // --- Router: intent + HITL triggers ---
  const intent = classifyIntent(userText, persona);
  // Ditemukan dari eval bahasa informal: "mnt tlg sambungin ke cs dong" tidak tertangkap pola awal
  // (hanya "minta cs"/"mau cs" literal) — ditambah pola lebih luwes untuk singkatan umum chat
  // informal ("sambungin"/"sambungkan"/"connect"/"minta"/"mnt" + "ke/sama/dgn cs/petugas/manusia").
  const explicitHumanRequest = /\b(bicara dengan (manusia|cs|petugas)|minta cs|mau cs|(sambung(in|kan)?|connect|m(i|n)ta|hubungkan)\b.{0,15}\b(cs|petugas|manusia))\b/i.test(userText.toLowerCase());
  const hitl = detectHitl(userText, input.failedUnderstandingCount, explicitHumanRequest);

  // Pengaduan WAJIB tercatat sebagai tiket ber-SLA — aksi berdampak kepatuhan dibuat DETERMINISTIK
  // oleh kode, bukan digantungkan ke kepatuhan LLM memanggil tool. PENTING: ini dijalankan SEBELUM
  // keputusan handoff di bawah (bukan setelah early-return) -> pengaduan paling serius (ancaman,
  // penagihan kasar) yang justru memicu handoff TETAP tercatat sebagai tiket dengan severity yang
  // sesuai, bukan hilang begitu saja saat dialihkan ke CS.
  let autoTicket: { ticket_id: string; sla_due_at: string; severity: string } | null = null;
  if (intent === "pengaduan") {
    const category = /penagihan|debt collector|\bdc\b/i.test(userText)
      ? "penagihan"
      : /data pribadi|kebocoran data|anggota majelis lain/i.test(userText)
        ? "data_pribadi"
        : persona === "pendana" || /pendanaan|pencairan dana|imbal hasil/i.test(userText)
          ? "pendanaan"
          : /produk|bunga|biaya|syarat/i.test(userText)
            ? "produk"
            : "layanan";
    const ticketSeverity = hitl.shouldHandoff ? hitl.severity : "normal";
    const result = await executeTool(
      env.DB,
      "create_complaint_ticket",
      { category, severity: ticketSeverity, subject: userText.slice(0, 100), description: userText },
      { verifiedActorId, actorType: persona === "pendana" ? "pendana" : "mitra", sessionId },
    );
    if (result.ok) {
      autoTicket = result.data;
      toolCallsMade.push({ tool: "create_complaint_ticket", ok: true });
      await appendAuditLog(env.DB, sessionId, "system", "tool_call", { tool: "create_complaint_ticket", ok: true, auto: true });
    }
  }

  if (hitl.shouldHandoff) {
    await appendAuditLog(env.DB, sessionId, "system", "handoff", { reason: hitl.reason, severity: hitl.severity, ticket_id: autoTicket?.ticket_id ?? null });
    const sev = hitl.severity === "critical" ? "Permintaan Anda sangat penting dan langsung kami eskalasi dengan prioritas tinggi." : "Baik, saya alihkan percakapan ini ke tim CS kami.";
    const ticketLine = autoTicket ? ` Pengaduan Anda sudah tercatat dengan nomor tiket ${autoTicket.ticket_id}.` : "";
    const text = `${sev}${ticketLine} Mohon tunggu sebentar, CS kami akan segera membantu Anda.`;
    onToken(text);
    return {
      answerText: text,
      citations: [],
      intent,
      handoff: { triggered: true, reason: hitl.reason, severity: hitl.severity },
      verifiedActorId,
      toolCallsMade,
      modelUsed: "none",
      timing: { firstTokenMs: 0, totalMs: Date.now() - turnStartedAt },
    };
  }

  // Hak subjek data (DSR) juga dicatat deterministik begitu intent terdeteksi, AI tetap TIDAK
  // mengeksekusi permintaan (hapus/koreksi) secara otomatis — hanya mencatat tiket.
  let autoDsr: { dsr_id: string } | null = null;
  if (intent === "hak_data") {
    const requestType = /hapus/i.test(userText)
      ? "delete"
      : /koreksi|perbaiki|ubah/i.test(userText)
        ? "correction"
        : /keberatan|automated|otomatis/i.test(userText)
          ? "object_automated_decision"
          : "access";
    const result = await executeTool(env.DB, "create_dsr_request", { request_type: requestType, detail: userText.slice(0, 500) }, { verifiedActorId, actorType: persona === "pendana" ? "pendana" : "mitra", sessionId });
    if (result.ok) {
      autoDsr = result.data;
      toolCallsMade.push({ tool: "create_dsr_request", ok: true });
      await appendAuditLog(env.DB, sessionId, "system", "tool_call", { tool: "create_dsr_request", ok: true, auto: true });
    }
  }

  // Keterlambatan/restrukturisasi (mitra): dicatat deterministik sebagai permintaan untuk ditinjau
  // petugas lapangan — SELARAS Pasal 10 UU PDP (larangan keputusan otomatis berdampak signifikan),
  // AI TIDAK PERNAH memutuskan/menjanjikan hasil restrukturisasi. Jika sesi belum terverifikasi TAPI
  // pesan ini sendiri menyertakan nomor pinjaman + tanggal lahir (pola umum: minta keringanan di
  // pesan pertama sekaligus), verifikasi deterministik di sini dulu -> pencatatan restrukturisasi
  // TIDAK bergantung pada LLM berhasil merangkai verify_mitra -> create_restructuring_request sendiri
  // dalam urutan & langkah yang tepat (diamati: tidak selalu konsisten, lihat README §Temuan Eval).
  if (intent === "keterlambatan" && persona === "mitra" && !verifiedActorId) {
    const pinjamanMatch = userText.match(/\bMMK-\d{6}\b/i);
    const birthMatch = userText.match(/\b\d{4}-\d{2}-\d{2}\b/);
    if (pinjamanMatch && birthMatch) {
      const verifyResult = await executeTool(env.DB, "verify_mitra", { pinjaman_no: pinjamanMatch[0].toUpperCase(), birth_date: birthMatch[0] }, { verifiedActorId: null, actorType: null, sessionId });
      if (verifyResult.ok && verifyResult.data?.verified) {
        verifiedActorId = verifyResult.data.actor_id;
        allowedIds.add(String(verifiedActorId).toUpperCase());
        toolCallsMade.push({ tool: "verify_mitra", ok: true });
        await appendAuditLog(env.DB, sessionId, "system", "tool_call", { tool: "verify_mitra", ok: true, auto: true });
      }
    }
  }
  let autoRestru: { restru_id: string } | null = null;
  if (intent === "keterlambatan" && persona === "mitra" && verifiedActorId) {
    const result = await executeTool(env.DB, "create_restructuring_request", { reason: userText.slice(0, 500) }, { verifiedActorId, actorType: "mitra", sessionId });
    if (result.ok) {
      autoRestru = result.data;
      toolCallsMade.push({ tool: "create_restructuring_request", ok: true });
      await appendAuditLog(env.DB, sessionId, "system", "tool_call", { tool: "create_restructuring_request", ok: true, auto: true });
    }
  }

  // --- RAG retrieval ---
  const chunks: RetrievedChunk[] = await retrieve(env.AI, env.VECTORIZE, env.EMBED_MODEL, userText, 8);
  const retrievedIds = new Set(chunks.map((c) => c.id.toLowerCase()));
  await appendAuditLog(env.DB, sessionId, "system", "retrieve", { query_redacted: redacted, result_ids: [...retrievedIds], count: chunks.length });
  const usedRag = chunks.length > 0;

  let ragContext = formatChunksAsContext(chunks);
  if (autoTicket) {
    ragContext += `\n---\n${wrapAsData("tiket_pengaduan_otomatis", JSON.stringify(autoTicket))}\nSistem sudah mencatat pengaduan ini sebagai tiket ${autoTicket.ticket_id} dengan tenggat ${autoTicket.sla_due_at}. Sebutkan nomor tiket dan tenggat ini di jawaban Anda.`;
  }
  if (autoDsr) {
    ragContext += `\n---\n${wrapAsData("dsr_otomatis", JSON.stringify(autoDsr))}\nSistem sudah mencatat permintaan hak data ini sebagai ${autoDsr.dsr_id}. Jelaskan bahwa permintaan TIDAK dieksekusi otomatis dan akan ditinjau tim berwenang, sebutkan nomor ${autoDsr.dsr_id}.`;
  }
  if (autoRestru) {
    ragContext += `\n---\n${wrapAsData("restrukturisasi_otomatis", JSON.stringify(autoRestru))}\nSistem sudah mencatat permintaan restrukturisasi/keringanan ini sebagai ${autoRestru.restru_id}. Jelaskan bahwa ini akan ditinjau petugas lapangan/tim kredit, TIDAK ADA keputusan/jaminan otomatis, sebutkan nomor ${autoRestru.restru_id}.`;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(persona, verifiedActorId) },
    { role: "user", content: buildUserTurn(redacted, wrapAsData("konteks_rag", ragContext)) },
  ];

  let finalText = "";
  let citations: string[] = [];
  let modelUsed = "none";

  // CATATAN STREAMING: Workers AI `stream:true` untuk @cf/qwen/qwen3-30b-a3b-fp8 TERBUKTI merusak
  // karakter kutip pada output JSON terstruktur (diverifikasi via endpoint debug sementara -
  // non-streaming selalu valid, streaming konsisten menjatuhkan `"` di sekitar key/value awal),
  // kemungkinan bug detokenizer streaming Workers AI untuk model ini. Demi keandalan JSON tool-
  // calling & guardrail, panggilan LLM di loop ini NON-STREAMING; token tetap "mengalir" ke
  // pengguna lewat relay berjeda di bawah SETELAH teks lolos guard (lihat relayFinalText), bukan
  // mentah dari model. Lihat README §Keputusan Desain untuk detail & bukti.
  for (let step = 0; step < MAX_STEPS; step++) {
    const llmRes = await callChatModel(env.AI, env.MODEL_PRIMARY, messages);
    modelUsed = llmRes.modelUsed;
    await appendAuditLog(env.DB, sessionId, "ai", "llm_call", { step, model: llmRes.modelUsed, degraded: llmRes.degraded });

    const parsed = safeParseAgentJson(llmRes.text);
    if (!parsed) {
      finalText = llmRes.text || FALLBACK_NOT_FOUND;
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
        await appendAuditLog(env.DB, sessionId, "system", "tool_call_invalid", { tool: toolName, issues: argsParse.error.issues });
        messages.push({ role: "assistant", content: llmRes.text });
        messages.push({ role: "user", content: buildToolResultTurn(toolName, JSON.stringify({ ok: false, error: "argumen tidak valid" })) });
        continue;
      }

      const actorType: "mitra" | "pendana" | null = persona === "pendana" ? "pendana" : persona === "mitra" ? "mitra" : null;

      // Idempotensi dalam-turn: pengaduan/DSR/restrukturisasi SUDAH dicatat deterministik oleh kode
      // di atas (lihat autoTicket/autoDsr/autoRestru) begitu intent terdeteksi. Jika LLM JUGA mencoba
      // memanggil tool yang sama di langkah ini, kembalikan catatan yang SUDAH ada, jangan buat
      // tiket/DSR/restrukturisasi duplikat.
      let result: { ok: boolean; data?: any; error?: string };
      if (toolName === "create_complaint_ticket" && autoTicket) {
        result = { ok: true, data: autoTicket };
      } else if (toolName === "create_dsr_request" && autoDsr) {
        result = { ok: true, data: autoDsr };
      } else if (toolName === "create_restructuring_request" && autoRestru) {
        result = { ok: true, data: autoRestru };
      } else {
        result = await executeTool(env.DB, toolName, argsParse.data as any, { verifiedActorId, actorType, sessionId });
      }
      toolCallsMade.push({ tool: toolName, ok: result.ok });
      await appendAuditLog(env.DB, sessionId, "ai", "tool_call", { tool: toolName, ok: result.ok });

      if ((toolName === "verify_mitra" || toolName === "verify_pendana") && result.ok && result.data?.verified) {
        verifiedActorId = result.data.actor_id;
        allowedIds.add(String(verifiedActorId).toUpperCase());
      }
      // LLM memanggil handoff_to_human -> mode HARUS benar-benar berubah ke HUMAN (via field
      // handoff.triggered yang dibaca ChatSession.ts), BUKAN cuma tool yang "sukses" lalu LLM
      // menyusun kalimat "sudah dialihkan" padahal mode tetap AI (bug nyata jika tidak ditangani).
      if (toolName === "handoff_to_human" && result.ok) {
        await appendAuditLog(env.DB, sessionId, "system", "handoff", { reason: result.data?.reason ?? "tool_call_llm", severity: "normal", ticket_id: autoTicket?.ticket_id ?? null });
        const ticketLine = autoTicket ? ` Pengaduan Anda sudah tercatat dengan nomor tiket ${autoTicket.ticket_id}.` : "";
        const text = `Baik, saya alihkan percakapan ini ke tim CS kami.${ticketLine} Mohon tunggu sebentar, CS kami akan segera membantu Anda.`;
        onToken(text);
        return {
          answerText: text,
          citations: [],
          intent,
          handoff: { triggered: true, reason: result.data?.reason ?? "tool_call_llm", severity: "normal" },
          verifiedActorId,
          toolCallsMade,
          modelUsed: llmRes.modelUsed,
          timing: { firstTokenMs: 0, totalMs: Date.now() - turnStartedAt },
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

    finalText = llmRes.text;
    break;
  }

  if (!finalText) finalText = FALLBACK_NOT_FOUND;
  // Temuan review: LLM kadang menyalin token redaksi ("[PINJAMAN_1]") mentah ke jawaban. De-tokenisasi
  // SEBELUM guard output di bawah (termasuk scanOutputForPII) memeriksa teks final.
  finalText = resolveLeakedTokensInText(finalText, vault);

  // --- GUARD (output/critic): sitasi wajib, groundedness, larangan janji, scan PII, privasi antar-majelis ---
  const citationRelevant = usedRag && intent !== "akun";
  const outputCheck = checkOutput(finalText, citationRelevant);
  let blockedByGuard: string | undefined;
  if (!outputCheck.ok) {
    await appendAuditLog(env.DB, sessionId, "system", "output_guard_block", { reason: outputCheck.reason, piiLeak: outputCheck.piiLeak });
    finalText = FALLBACK_NOT_FOUND;
    citations = [];
    blockedByGuard = outputCheck.reason;
  } else if (citations.length > 0) {
    const grounded = checkCitationsGrounded(finalText, retrievedIds);
    if (!grounded.grounded) {
      await appendAuditLog(env.DB, sessionId, "system", "output_guard_block", { reason: "sitasi tidak ditemukan di konteks", invalid: grounded.invalid });
      finalText = FALLBACK_NOT_FOUND;
      citations = [];
      blockedByGuard = "sitasi_tidak_grounded";
    }
  }
  if (!blockedByGuard) {
    const privacyCheck = checkMemberPrivacyLeak(finalText, allowedIds);
    if (!privacyCheck.ok) {
      await appendAuditLog(env.DB, sessionId, "system", "output_guard_block", { reason: "privasi_antar_majelis", leaked: privacyCheck.leaked });
      finalText = "Maaf, saya tidak dapat menampilkan data yang bukan milik Anda. Jika ini terkait data Anda sendiri, mohon verifikasi ulang; untuk hal lain saya alihkan ke CS.";
      citations = [];
      blockedByGuard = "privasi_antar_majelis";
    }
  }

  if (autoTicket && !finalText.includes(autoTicket.ticket_id)) {
    finalText += `\n\nPengaduan Anda telah dicatat dengan nomor tiket ${autoTicket.ticket_id}, akan ditindaklanjuti paling lambat ${new Date(autoTicket.sla_due_at).toLocaleDateString("id-ID")} sesuai SOP penanganan pengaduan kami.`;
  }
  if (autoDsr && !finalText.includes(autoDsr.dsr_id)) {
    finalText += `\n\nPermintaan hak data Anda telah dicatat dengan nomor ${autoDsr.dsr_id}. Permintaan ini akan ditinjau oleh tim yang berwenang dan tidak dieksekusi secara otomatis.`;
  }
  if (autoRestru && !finalText.includes(autoRestru.restru_id)) {
    finalText += `\n\nPermintaan restrukturisasi/keringanan Anda telah dicatat dengan nomor ${autoRestru.restru_id}, akan ditinjau petugas lapangan/tim kredit. Tidak ada keputusan otomatis.`;
  }

  await appendAuditLog(env.DB, sessionId, "ai", "output", { text_len: finalText.length, citations, intent });

  // "first token" di sini = waktu sampai teks LOLOS guard & mulai direlai ke pengguna (bukan token
  // mentah dari model, lihat catatan streaming di atas) — ini angka latensi yang pengguna benar-benar
  // rasakan sebelum melihat kata pertama muncul di layar.
  const firstTokenMs = Date.now() - turnStartedAt;
  await relayFinalText(finalText, onToken);

  return {
    answerText: finalText,
    citations,
    intent,
    handoff: { triggered: false, severity: "normal" },
    verifiedActorId,
    toolCallsMade,
    modelUsed,
    blockedByGuard,
    timing: { firstTokenMs, totalMs: Date.now() - turnStartedAt },
  };
}

function emptyBlockedResult(message: string, guard: string, turnStartedAt: number, verifiedActorId: string | null = null): AgentTurnOutput {
  return {
    answerText: message,
    citations: [],
    intent: "lain",
    handoff: { triggered: false, severity: "normal" },
    // PENTING: pertahankan verifiedActorId yang SUDAH ada di sesi ini -> satu pesan yang kena guard
    // (mis. false-positive Llama Guard) tidak boleh memaksa pengguna verifikasi ulang dari awal.
    verifiedActorId,
    toolCallsMade: [],
    modelUsed: "none",
    blockedByGuard: guard,
    timing: { firstTokenMs: 0, totalMs: Date.now() - turnStartedAt },
  };
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
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

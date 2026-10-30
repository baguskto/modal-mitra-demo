// Guard 4 (output/critic): wajib sitasi untuk klaim kebijakan, larangan janji finansial,
// scan PII bocor. Deterministik agar bisa dites presisi di promptfoo (bukan hanya LLM-judge).
import { scanOutputForPII } from "./pii";

const POLICY_CLAIM_SIGNAL = /\b(denda|bunga|tenor|sop|pasal|pojk|uu pdp|hak data|kebijakan|syarat|biaya|penalti|dp|uang muka)\b/i;
const CITATION_RE = /\[[a-z0-9-]+#[a-z0-9-]+\]/i;

const FORBIDDEN_PROMISE = [
  /pasti (disetujui|diterima|lolos|dikabulkan)/i,
  /dijamin (disetujui|diterima|lolos)/i,
  /saya (jamin|pastikan) (disetujui|lolos|diterima)/i,
  /100% (disetujui|diterima)/i,
  /plafon (anda |)pasti (naik|cair)/i,
  /restrukturisasi (anda |)pasti (disetujui|diterima)/i,
  /imbal hasil (yang |)dijamin/i,
  /dijamin (untung|cuan)/i,
  /pasti (lunas|tidak (ada |)risiko)/i,
];

export interface OutputCheckResult {
  ok: boolean;
  reason?: string;
  piiLeak?: string[];
}

export function checkOutput(answerText: string, usedRag: boolean): OutputCheckResult {
  const piiScan = scanOutputForPII(answerText);
  if (!piiScan.clean) {
    return { ok: false, reason: "PII mentah terdeteksi di jawaban sebelum dikirim", piiLeak: piiScan.findings };
  }

  for (const re of FORBIDDEN_PROMISE) {
    if (re.test(answerText)) {
      return { ok: false, reason: `Janji finansial terlarang terdeteksi (pola: ${re.source})` };
    }
  }

  if (usedRag && POLICY_CLAIM_SIGNAL.test(answerText) && !CITATION_RE.test(answerText)) {
    return { ok: false, reason: "Klaim kebijakan/aturan tanpa sitasi [doc#chunk] yang valid" };
  }

  return { ok: true };
}

/** Groundedness sederhana: setiap token sitasi yang disebut harus benar-benar ada di konteks yang diambil. */
export function checkCitationsGrounded(answerText: string, retrievedIds: Set<string>): { grounded: boolean; invalid: string[] } {
  const cited = [...answerText.matchAll(/\[([a-z0-9-]+#[a-z0-9-]+)\]/gi)].map((m) => m[1].toLowerCase());
  const invalid = cited.filter((c) => !retrievedIds.has(c));
  return { grounded: invalid.length === 0, invalid };
}

/**
 * Guard privasi antar-anggota majelis: jawaban final TIDAK BOLEH menyebut nomor pinjaman (MMK-xxxxxx)
 * atau ID pendana (PND-xxxx) yang BUKAN milik actor terverifikasi di sesi ini — dicek terhadap
 * `allowedIds` (dikumpulkan dari hasil tool_call turn ini, bukan dipercaya dari klaim LLM).
 * Mencegah kebocoran data anggota majelis lain, baik lewat halusinasi model maupun injeksi dokumen.
 */
export function checkMemberPrivacyLeak(answerText: string, allowedIds: Set<string>): { ok: boolean; leaked: string[] } {
  const found = [...answerText.matchAll(/\b(MMK-\d{6}|PND-\d{4})\b/gi)].map((m) => m[0].toUpperCase());
  const leaked = found.filter((id) => !allowedIds.has(id));
  return { ok: leaked.length === 0, leaked: [...new Set(leaked)] };
}

export const FALLBACK_NOT_FOUND =
  "Maaf, saya tidak menemukan informasi yang pasti untuk pertanyaan ini di basis pengetahuan resmi. Agar tidak memberi informasi yang salah, saya sarankan terhubung dengan CS kami untuk konfirmasi. Mau saya alihkan ke CS?";

// Ekor protokol JSON yang ditempel model di akhir prosa (lihat extractAnswerFallback di agent/graph.ts):
// 'Baik, Bu. ...","citations":["faq#1"]}' -> { text: "Baik, Bu. ...", citations: ["faq#1"] }.
const JSON_TAIL_RE = /"?\s*,\s*"citations"\s*:\s*(\[[^\]]*\])\s*\}?\s*$/;

export function salvageJsonTail(raw: string): { text: string; citations: string[] } | null {
  const m = raw.match(JSON_TAIL_RE);
  if (!m) return null;
  let citations: string[] = [];
  try {
    const arr = JSON.parse(m[1]);
    if (Array.isArray(arr)) citations = arr.filter((c) => typeof c === "string");
  } catch {}
  let text = raw.slice(0, m.index).replace(/^\s*\{?\s*"type"\s*:\s*"final_answer"\s*,\s*"text"\s*:\s*"/, "");
  text = text.replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  return { text, citations };
}


// Fitur #6b: online eval — LLM-as-judge pada TRAFIK LIVE (beda dari golden set 45 kasus yang
// dijalankan manual via `npm run eval`): tiap giliran chat (sampling, lihat ONLINE_EVAL_SAMPLE_RATE)
// dinilai oleh model kecil & murah (Kenari `deepseek-v4-1-flash`, lihat cache/kenariProvider.ts —
// reuse, tidak duplikasi provider), skor dikirim ke Langfuse sebagai `score-create` (Ingestion
// API yang sama dipakai LangfuseTrace milik worker inti) supaya muncul di dashboard Langfuse
// tanpa perlu dataset/eksperimen manual.
//
// Assertion deterministik (golden set) tetap gate UTAMA (murah, stabil, mudah didebug — lihat
// README §5/§6 existing) — online eval ini PELENGKAP untuk sinyal kualitas trafik nyata yang
// golden set statis tidak bisa lihat, BUKAN pengganti.
import { kenariChatComplete } from "../cache/kenariProvider";
import type { KenariEnv } from "../cache/kenariProvider";
import { basicAuthHeader, isLangfuseConfigured, type LangfuseConfig } from "./client";
import { xrayEvent, type ExtrasXrayEvent } from "../xray";

export const ONLINE_EVAL_SAMPLE_RATE = 0.2; // 1 dari 5 giliran — hemat biaya judge, cukup untuk tren.

export interface JudgeVerdict {
  groundedScore: number; // 0..1
  politeScore: number; // 0..1
  reason: string;
}

const JUDGE_SYSTEM = `Anda adalah judge internal untuk QA chatbot P2P lending. Nilai jawaban asisten terhadap pertanyaan pengguna & konteks yang diberikan. Balas HANYA JSON valid: {"groundedScore":0..1,"politeScore":0..1,"reason":"<maks 1 kalimat>"}. groundedScore=1 bila klaim faktual didukung konteks/sitasi yang ada, 0 bila mengada-ada. politeScore=1 bila sopan & sesuai aturan (tidak menjanjikan hasil finansial, tidak membuka data pihak lain).`;

function parseVerdict(raw: string): JudgeVerdict | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const clamp = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));
    return {
      groundedScore: clamp(parsed.groundedScore),
      politeScore: clamp(parsed.politeScore),
      reason: String(parsed.reason ?? "").slice(0, 300),
    };
  } catch {
    return null;
  }
}

export async function judgeTurn(
  env: KenariEnv,
  input: { question: string; answer: string; context: string },
  fetchImpl?: typeof fetch,
): Promise<JudgeVerdict | null> {
  const completion = await kenariChatComplete(
    env,
    "deepseek-v4-1-flash",
    [
      { role: "system", content: JUDGE_SYSTEM },
      {
        role: "user",
        content: `KONTEKS:\n${input.context.slice(0, 2000)}\n\nPERTANYAAN:\n${input.question.slice(0, 500)}\n\nJAWABAN ASISTEN:\n${input.answer.slice(0, 1000)}`,
      },
    ],
    200,
    fetchImpl,
  );
  return parseVerdict(completion.text);
}

/** Kirim skor ke Langfuse (Ingestion API, event `score-create`) — gagal kirim tidak pernah
 * melempar error (observability tidak boleh mengganggu giliran chat, selaras prinsip yang sama
 * di obs/langfuse.ts milik worker inti). */
export async function postScoreToLangfuse(
  cfg: LangfuseConfig | null,
  payload: { traceId: string; name: string; value: number; comment?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: boolean }> {
  if (!isLangfuseConfigured(cfg)) return { sent: false };
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: { authorization: basicAuthHeader(cfg), "content-type": "application/json" },
      body: JSON.stringify({
        batch: [
          {
            id: `score-${payload.traceId}-${payload.name}-${Date.now().toString(36)}`,
            type: "score-create",
            timestamp: new Date().toISOString(),
            body: { traceId: payload.traceId, name: payload.name, value: payload.value, comment: payload.comment },
          },
        ],
      }),
    });
    return { sent: res.ok };
  } catch {
    return { sent: false };
  }
}

export interface OnlineEvalEnv extends KenariEnv {
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
}

function langfuseConfigFromEnv(env: OnlineEvalEnv): LangfuseConfig | null {
  if (!env.LANGFUSE_BASE_URL || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  return { baseUrl: env.LANGFUSE_BASE_URL, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY };
}

/** Menentukan apakah giliran ini kena sampel (dipisah murni dari Math.random langsung supaya
 * dites deterministik dengan RNG yang diinjeksi). */
export function shouldSample(rng: () => number = Math.random): boolean {
  return rng() < ONLINE_EVAL_SAMPLE_RATE;
}

export interface RunOnlineEvalResult {
  sampled: boolean;
  verdict: JudgeVerdict | null;
  scoreSent: boolean;
  xray: ExtrasXrayEvent;
}

/**
 * Titik integrasi: panggil SETELAH final_answer dikirim ke pengguna (non-blocking, lewat
 * `ctx.waitUntil` di sisi worker inti) — judge TIDAK PERNAH menahan balasan ke pengguna.
 */
export async function runOnlineEval(
  env: OnlineEvalEnv,
  input: { traceId: string; question: string; answer: string; context: string; sessionId?: string },
  rng: () => number = Math.random,
): Promise<RunOnlineEvalResult> {
  if (!shouldSample(rng)) {
    return { sampled: false, verdict: null, scoreSent: false, xray: xrayEvent("online_eval", { sampled: false }, input.sessionId) };
  }

  const verdict = await judgeTurn(env, input).catch(() => null);
  if (!verdict) {
    return { sampled: true, verdict: null, scoreSent: false, xray: xrayEvent("online_eval", { sampled: true, judgeFailed: true }, input.sessionId) };
  }

  const cfg = langfuseConfigFromEnv(env);
  const [grounded, polite] = await Promise.all([
    postScoreToLangfuse(cfg, { traceId: input.traceId, name: "online_grounded", value: verdict.groundedScore, comment: verdict.reason }),
    postScoreToLangfuse(cfg, { traceId: input.traceId, name: "online_polite", value: verdict.politeScore }),
  ]);

  return {
    sampled: true,
    verdict,
    scoreSent: grounded.sent && polite.sent,
    xray: xrayEvent(
      "online_eval",
      { sampled: true, groundedScore: verdict.groundedScore, politeScore: verdict.politeScore, scoreSent: grounded.sent && polite.sent },
      input.sessionId,
    ),
  };
}

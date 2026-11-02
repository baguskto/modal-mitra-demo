// Klien Kenari (OmniRoute) — proxy OpenAI-compatible milik Bagus sendiri (paket Studio). Dipakai
// sebagai provider chat UTAMA (lihat README §0.1 untuk insiden kuota Workers AI yang memicu ini).
//
// feat/latency-xray (2 Nov 2026):
//  - Model chat sekarang dipilih lewat `KENARI_CHAT_MODEL` (wrangler.toml [vars]) dengan default
//    DEFAULT_CHAT_MODEL di bawah — dipilih setelah DIUKUR (scripts/bench-models.ts, evals/model-bench.json),
//    HANYA dari scope_models paket Studio yang terbukti `billing_kind: "plan"` di GET /v1/usage hari itu.
//  - `reasoning_effort` dikirim eksplisit ("none" untuk keluarga gpt-6): tugas CS ini tidak butuh
//    reasoning tersembunyi, dan token reasoning adalah sumber utama latensi first-token.
//  - Streaming (`kenariChatStream`): token jawaban akhir diteruskan ke UI sambil di-guard per kalimat
//    (src/guards/streamGuard.ts) — bukan lagi relay buatan setelah seluruh jawaban selesai.
//  - kenariEmbed DIHAPUS: model `bge-m3` di Kenari TIDAK ada di scope_models paket Studio -> ditagih
//    PAYG (terlihat di GET /v1/usage 2 Nov: bge-m3 billing_kind "payg", cost > 0). Embedding RAG
//    sekarang Workers AI @cf/baai/bge-m3 (dimensi 1024 sama) + fallback BM25 lokal (src/agent/rag.ts).
//  - gpt-6-astra SENGAJA TIDAK dipakai (PAYG terpisah, bukan bagian paket Studio).

const KENARI_BASE_URL = "https://kenari.id/v1";
export const DEFAULT_CHAT_MODEL = "gpt-6-luna";

/** Model yang BOLEH dipakai (scope_models Studio + terbukti plan). Nilai lain -> default (fail-safe ke plan). */
const PLAN_MODELS: Record<string, { reasoning?: string }> = {
  "gpt-6-luna": { reasoning: "none" },
  "gpt-6-1-terra": { reasoning: "none" },
  "deepseek-v4-1-flash": { reasoning: "none" },
  "gemini-3-7-flash": { reasoning: "low" },
};

export function resolveKenariModel(requested?: string): string {
  return requested && PLAN_MODELS[requested] ? requested : DEFAULT_CHAT_MODEL;
}

export interface KenariUsage {
  input?: number;
  output?: number;
}

export interface KenariResult {
  text: string | null;
  model: string;
  usage?: KenariUsage;
  ms: number;
  ttftMs?: number;
}

function body(model: string, messages: { role: string; content: string }[], opts: { temperature?: number; max_tokens?: number }, stream: boolean) {
  const reasoning = PLAN_MODELS[model]?.reasoning;
  return JSON.stringify({
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.max_tokens ?? 1024, // WAJIB diset eksplisit (instruksi Bagus) -> batasi biaya per panggilan.
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  });
}

function usageOf(u: any): KenariUsage | undefined {
  if (!u) return undefined;
  return { input: u.prompt_tokens, output: u.completion_tokens };
}

export async function kenariChatCompletion(
  apiKey: string,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; max_tokens?: number; model?: string; signal?: AbortSignal } = {},
): Promise<KenariResult> {
  const model = resolveKenariModel(opts.model);
  const t0 = Date.now();
  try {
    const res = await fetch(`${KENARI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: body(model, messages, opts, false),
      signal: opts.signal,
    });
    if (!res.ok) {
      console.error("kenari_chat_http_error", res.status, (await res.text()).slice(0, 300));
      return { text: null, model, ms: Date.now() - t0 };
    }
    const data: any = await res.json();
    return { text: data?.choices?.[0]?.message?.content ?? null, model, usage: usageOf(data?.usage), ms: Date.now() - t0 };
  } catch (err: any) {
    console.error("kenari_chat_error", err?.message ?? String(err));
    return { text: null, model, ms: Date.now() - t0 };
  }
}

/**
 * Streaming chat completion (SSE OpenAI-compatible). `onDelta` dipanggil per potongan teks segera
 * setelah tiba — pemanggil (graph.ts) meneruskannya ke StreamGuard, BUKAN langsung ke pengguna.
 * Tidak pernah melempar: error jaringan/HTTP -> `text: null` (pemanggil jatuh ke jalur fallback).
 */
export async function kenariChatStream(
  apiKey: string,
  messages: { role: string; content: string }[],
  onDelta: (delta: string) => void | Promise<void>,
  opts: { temperature?: number; max_tokens?: number; model?: string; signal?: AbortSignal } = {},
): Promise<KenariResult> {
  const model = resolveKenariModel(opts.model);
  const t0 = Date.now();
  let ttftMs: number | undefined;
  let text = "";
  let usage: KenariUsage | undefined;
  try {
    const res = await fetch(`${KENARI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: body(model, messages, opts, true),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      console.error("kenari_stream_http_error", res.status, (await res.text()).slice(0, 300));
      return { text: null, model, ms: Date.now() - t0 };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      if (opts.signal?.aborted) {
        await reader.cancel().catch(() => {});
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let j: any;
        try {
          j = JSON.parse(payload);
        } catch {
          continue;
        }
        const d = j?.choices?.[0]?.delta?.content;
        if (typeof d === "string" && d.length > 0) {
          if (ttftMs === undefined) ttftMs = Date.now() - t0;
          text += d;
          await onDelta(d);
        }
        if (j?.usage) usage = usageOf(j.usage);
      }
    }
    return { text: text || null, model, usage, ms: Date.now() - t0, ttftMs };
  } catch (err: any) {
    if (!opts.signal?.aborted) console.error("kenari_stream_error", err?.message ?? String(err));
    return { text: text || null, model, usage, ms: Date.now() - t0, ttftMs };
  }
}

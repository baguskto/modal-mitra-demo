// Wrapper panggilan LLM dengan fallback multi-provider. Kenari (paket Studio, model plan) utama,
// Workers AI cadangan — lihat README §0.1 untuk riwayat keputusan (kuota Workers AI habis saat migrasi).
//
// feat/latency-xray (2 Nov 2026):
//  - `callChatModel` (non-streaming) tetap untuk loop ReAct JSON & ringkasan handoff.
//  - `streamChatModel` (BARU) untuk jawaban akhir: streaming token + HEDGED REQUEST. Latensi
//    first-token Kenari terukur sangat bervariasi (scripts/bench-models.ts: gpt-6-luna 2.3–7.1 s,
//    deepseek-v4-1-flash 1.9–39 s, gemini-3-7-flash 10–74 s untuk prompt yang sama). Bila Kenari belum
//    menghasilkan token pertama dalam `hedgeAfterMs`, model Workers AI (co-located dengan Worker,
//    tanpa hop jaringan eksternal) dijalankan PARALEL; siapa pun yang menghasilkan token pertama lebih
//    dulu yang dipakai, yang kalah dibatalkan. Kedua jalur memakai prompt & guard streaming yang sama.
//    Panggilan Workers AI hanya terjadi pada giliran yang Kenari-nya lambat (bukan setiap giliran),
//    jadi pemakaian kuota harian Workers AI tetap kecil.
import { kenariChatCompletion, kenariChatStream, resolveKenariModel, type KenariUsage } from "./kenari";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallResult {
  text: string;
  modelUsed: string;
  degraded: boolean;
  usage?: KenariUsage;
  ms: number;
}

const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

export async function callChatModel(
  ai: Ai,
  primaryModel: string,
  messages: ChatMessage[],
  opts: { temperature?: number; max_tokens?: number; kenariModel?: string } = {},
  kenariApiKey?: string,
): Promise<LlmCallResult> {
  const t0 = Date.now();
  const common = { temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 1024 };

  if (kenariApiKey) {
    const res = await kenariChatCompletion(kenariApiKey, messages, { ...common, model: opts.kenariModel });
    if (res.text) return { text: res.text, modelUsed: `kenari:${res.model}`, degraded: false, usage: res.usage, ms: Date.now() - t0 };
    console.error("llm_kenari_empty_or_error — jatuh ke Workers AI");
  }

  try {
    const res: any = await ai.run(primaryModel as any, { messages, ...common });
    const text = extractText(res);
    if (text) return { text, modelUsed: primaryModel, degraded: !!kenariApiKey, ms: Date.now() - t0 };
    console.error("llm_primary_empty", JSON.stringify(res).slice(0, 500));
    throw new Error("Respons model utama kosong");
  } catch (err: any) {
    console.error("llm_primary_error", primaryModel, err?.message ?? String(err));
    try {
      const res: any = await ai.run(FALLBACK_MODEL as any, { messages, ...common });
      const text = extractText(res);
      if (text) return { text, modelUsed: FALLBACK_MODEL, degraded: true, ms: Date.now() - t0 };
      throw new Error("Respons model fallback kosong");
    } catch (err2: any) {
      console.error("llm_fallback_error", err2?.message ?? String(err2));
      return { text: "", modelUsed: "none", degraded: true, ms: Date.now() - t0 };
    }
  }
}

export function extractText(res: any): string | null {
  if (!res) return null;
  if (typeof res === "string") return res;
  if (typeof res.response === "string" && res.response.length > 0) return res.response;
  // Beberapa model Workers AI (mis. Qwen3) mengembalikan format OpenAI-compatible chat.completions.
  const choiceContent = res?.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string" && choiceContent.length > 0) return choiceContent;
  return null;
}

export interface StreamAttempt {
  provider: "kenari" | "workers_ai";
  model: string;
  startedAtMs: number; // relatif terhadap awal panggilan streamChatModel
  ttftMs?: number;
  ms: number;
  outcome: "menang" | "dibatalkan" | "gagal" | "selesai";
  usage?: KenariUsage;
}

export interface StreamCallResult {
  text: string | null;
  modelUsed: string;
  degraded: boolean;
  usage?: KenariUsage;
  ttftMs?: number;
  ms: number;
  hedged: boolean;
  attempts: StreamAttempt[];
}

/**
 * Streaming jawaban akhir dengan hedging Kenari ↔ Workers AI. `onDelta` hanya menerima potongan
 * dari SATU penyedia (pemenang token pertama) — tidak pernah campuran. Tidak pernah melempar.
 */
export async function streamChatModel(
  ai: Ai,
  workersModel: string,
  messages: ChatMessage[],
  onDelta: (d: string) => void | Promise<void>,
  opts: { kenariApiKey?: string; kenariModel?: string; hedgeAfterMs?: number; max_tokens?: number } = {},
): Promise<StreamCallResult> {
  const t0 = Date.now();
  const maxTokens = opts.max_tokens ?? 700;
  // Objek (bukan `let`) supaya penyempitan tipe TS tidak salah mengira nilainya selalu null.
  const race: { winner: "kenari" | "workers_ai" | null } = { winner: null };
  const kCtrl = new AbortController();
  const wCtrl = new AbortController();
  const attempts: StreamAttempt[] = [];
  const hedge: { p: Promise<WorkersStreamResult> | null; timer: any } = { p: null, timer: null };

  const startWorkers = (): Promise<WorkersStreamResult> => {
    if (hedge.p) return hedge.p;
    const startedAtMs = Date.now() - t0;
    hedge.p = workersAiStream(ai, workersModel, messages, maxTokens, wCtrl.signal, async (d) => {
      if (race.winner === null) {
        race.winner = "workers_ai";
        kCtrl.abort();
      }
      if (race.winner === "workers_ai") await onDelta(d);
    }).then((r) => {
      attempts.push({ provider: "workers_ai", model: workersModel, startedAtMs, ttftMs: r.ttftMs, ms: r.ms, outcome: race.winner === "workers_ai" ? "menang" : r.text ? "dibatalkan" : wCtrl.signal.aborted ? "dibatalkan" : "gagal" });
      return r;
    });
    return hedge.p;
  };

  const kenariModel = resolveKenariModel(opts.kenariModel);
  if (opts.kenariApiKey) {
    hedge.timer = setTimeout(() => {
      if (race.winner === null) startWorkers();
    }, opts.hedgeAfterMs ?? 1800);
    const k = await kenariChatStream(
      opts.kenariApiKey,
      messages,
      async (d) => {
        if (race.winner === null) {
          race.winner = "kenari";
          clearTimeout(hedge.timer);
          wCtrl.abort();
        }
        if (race.winner === "kenari") await onDelta(d);
      },
      { model: kenariModel, max_tokens: maxTokens, signal: kCtrl.signal },
    );
    clearTimeout(hedge.timer);
    attempts.push({ provider: "kenari", model: kenariModel, startedAtMs: 0, ttftMs: k.ttftMs, ms: k.ms, outcome: race.winner === "kenari" ? "menang" : kCtrl.signal.aborted ? "dibatalkan" : "gagal", usage: k.usage });
    if (race.winner === "kenari") {
      if (hedge.p) await hedge.p.catch(() => null);
      return { text: k.text, modelUsed: `kenari:${kenariModel}`, degraded: false, usage: k.usage, ttftMs: k.ttftMs, ms: Date.now() - t0, hedged: !!hedge.p, attempts };
    }
  }
  // Kenari kalah (Workers AI token pertama lebih dulu) ATAU gagal tanpa token / tidak dikonfigurasi.
  const w = await startWorkers();
  return {
    text: w.text,
    modelUsed: w.text ? workersModel : "none",
    degraded: !!opts.kenariApiKey,
    ttftMs: w.ttftMs !== undefined ? w.ttftMs + (attempts.find((a) => a.provider === "workers_ai")?.startedAtMs ?? 0) : undefined,
    ms: Date.now() - t0,
    hedged: !!opts.kenariApiKey,
    attempts,
  };
}

interface WorkersStreamResult {
  text: string | null;
  ttftMs?: number;
  ms: number;
}

/** Streaming Workers AI (SSE `data: {"response": "..."}`), membuang blok <think>…</think> Qwen3. */
async function workersAiStream(
  ai: Ai,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  signal: AbortSignal,
  onDelta: (d: string) => void | Promise<void>,
): Promise<WorkersStreamResult> {
  const t0 = Date.now();
  let text = "";
  let ttftMs: number | undefined;
  // Qwen3: "/no_think" mematikan mode reasoning (lebih cepat); blok <think> kosong tetap dibuang di bawah.
  const msgs = messages.map((m, i) => (i === messages.length - 1 && m.role === "user" ? { ...m, content: `${m.content}\n\n/no_think` } : m));
  try {
    const stream: any = await ai.run(model as any, { messages: msgs, stream: true, max_tokens: maxTokens, temperature: 0.2 } as any);
    if (signal.aborted) return { text: null, ms: Date.now() - t0 };
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    let pending = ""; // tampung awal output sampai yakin bukan/sudah lewat blok <think>
    let thinkDone = false;
    for (;;) {
      if (signal.aborted) {
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
        let d: string | undefined = typeof j?.response === "string" ? j.response : j?.choices?.[0]?.delta?.content;
        if (!d) continue;
        if (!thinkDone) {
          pending += d;
          const t = pending.trimStart();
          if (t.startsWith("<think>")) {
            const end = pending.indexOf("</think>");
            if (end < 0) continue;
            d = pending.slice(end + "</think>".length).replace(/^\s+/, "");
          } else if ("<think>".startsWith(t) && t.length < 7) {
            continue; // belum cukup karakter untuk memutuskan
          } else {
            d = pending;
          }
          thinkDone = true;
          pending = "";
          if (!d) continue;
        }
        if (ttftMs === undefined) ttftMs = Date.now() - t0;
        text += d;
        await onDelta(d);
      }
    }
    return { text: text || null, ttftMs, ms: Date.now() - t0 };
  } catch (err: any) {
    console.error("workers_ai_stream_error", model, err?.message ?? String(err));
    return { text: text || null, ttftMs, ms: Date.now() - t0 };
  }
}

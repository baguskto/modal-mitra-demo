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
//    jadi pemakaian kuota harian Workers AI tetap kecil. Hedge kedua = model Kenari plan lain dengan
//    upstream berbeda (deepseek-v4-1-flash) — keterlambatan antar-upstream saling independen.
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
  /** Kandidat balapan yang dijadwalkan (provider:model@delay) — untuk X-Ray. */
  candidates?: string[];
}

/**
 * Streaming jawaban akhir dengan HEDGING lintas penyedia. Kandidat (urut, dengan waktu mulai):
 *   1. Kenari `kenariModel` (utama)                 — mulai 0 ms
 *   2. Kenari `kenariHedgeModel` (upstream berbeda) — mulai `hedgeAfterMs` bila belum ada token
 *   3. Workers AI `workersModel` (co-located)       — mulai `workersAfterMs` (default = hedgeAfterMs)
 * Kandidat yang GAGAL tanpa token langsung memicu kandidat berikutnya (tanpa menunggu timer).
 * Siapa pun yang menghasilkan token pertama menang; sisanya dibatalkan (AbortController). `onDelta`
 * hanya menerima potongan dari SATU pemenang — tidak pernah campuran. Tidak pernah melempar.
 */
export async function streamChatModel(
  ai: Ai,
  workersModel: string,
  messages: ChatMessage[],
  onDelta: (d: string) => void | Promise<void>,
  opts: { kenariApiKey?: string; kenariModel?: string; kenariHedgeModel?: string; hedgeAfterMs?: number; workersAfterMs?: number; max_tokens?: number } = {},
): Promise<StreamCallResult> {
  const t0 = Date.now();
  const maxTokens = opts.max_tokens ?? 700;
  const hedgeAfterMs = opts.hedgeAfterMs ?? 1500;
  // Objek (bukan `let`) supaya penyempitan tipe TS tidak salah mengira nilainya selalu null.
  const race: { winner: number | null } = { winner: null };
  const attempts: StreamAttempt[] = [];

  type Cand = { provider: "kenari" | "workers_ai"; model: string; delay: number; ctrl: AbortController; started?: Promise<{ text: string | null; ttftMs?: number; usage?: KenariUsage }>; timer?: any };
  const cands: Cand[] = [];
  if (opts.kenariApiKey) {
    const primary = resolveKenariModel(opts.kenariModel);
    cands.push({ provider: "kenari", model: primary, delay: 0, ctrl: new AbortController() });
    if (opts.kenariHedgeModel && resolveKenariModel(opts.kenariHedgeModel) !== primary) cands.push({ provider: "kenari", model: resolveKenariModel(opts.kenariHedgeModel), delay: hedgeAfterMs, ctrl: new AbortController() });
  }
  // workersAfterMs < 0 -> Workers AI tidak ikut balapan (mis. anggaran neuron harian tercapai, aiBudget.ts).
  const workersDelay = opts.kenariApiKey ? opts.workersAfterMs ?? hedgeAfterMs : 0;
  if (workersDelay >= 0) cands.push({ provider: "workers_ai", model: workersModel, delay: workersDelay, ctrl: new AbortController() });

  let resolveDone!: () => void;
  const allDone = new Promise<void>((r) => (resolveDone = r));
  let finished = 0;
  let launched = 0;

  const launch = (i: number) => {
    const c = cands[i];
    if (c.started || race.winner !== null) return;
    clearTimeout(c.timer);
    launched++;
    const startedAtMs = Date.now() - t0;
    const onD = async (d: string) => {
      if (race.winner === null) {
        race.winner = i;
        cands.forEach((o, j) => {
          if (j !== i) {
            clearTimeout(o.timer);
            o.ctrl.abort();
          }
        });
      }
      if (race.winner === i) await onDelta(d);
    };
    c.started = (
      c.provider === "kenari"
        ? kenariChatStream(opts.kenariApiKey!, messages, onD, { model: c.model, max_tokens: maxTokens, signal: c.ctrl.signal })
        : workersAiStream(ai, c.model, messages, maxTokens, c.ctrl.signal, onD)
    ).then((r: any) => {
      attempts.push({
        provider: c.provider,
        model: c.model,
        startedAtMs,
        ttftMs: r.ttftMs,
        ms: r.ms,
        outcome: race.winner === i ? "menang" : c.ctrl.signal.aborted ? "dibatalkan" : "gagal",
        usage: r.usage,
      });
      // Gagal tanpa token & belum ada pemenang -> segera jalankan kandidat berikutnya.
      if (race.winner === null) for (let j = i + 1; j < cands.length; j++) if (!cands[j].started) { launch(j); break; }
      finished++;
      if (finished === launched && (race.winner !== null || cands.every((x) => x.started))) resolveDone();
      return r;
    });
  };

  cands.forEach((c, i) => {
    if (c.delay === 0) launch(i);
    else c.timer = setTimeout(() => launch(i), c.delay);
  });
  await allDone;
  cands.forEach((c) => clearTimeout(c.timer));

  const w = race.winner;
  if (w === null) return { text: null, modelUsed: "none", degraded: true, ms: Date.now() - t0, hedged: launched > 1, attempts };
  const win = cands[w];
  const r = await win.started!;
  const winAttempt = attempts.find((a) => a.provider === win.provider && a.model === win.model);
  return {
    text: r.text,
    modelUsed: win.provider === "kenari" ? `kenari:${win.model}` : win.model,
    degraded: win.provider !== "kenari" || w !== 0,
    usage: r.usage,
    ttftMs: r.ttftMs !== undefined ? r.ttftMs + (winAttempt?.startedAtMs ?? 0) : undefined,
    ms: Date.now() - t0,
    hedged: launched > 1,
    attempts: attempts.sort((a, b) => a.startedAtMs - b.startedAtMs),
    candidates: cands.map((c) => `${c.provider}:${c.model}@${c.delay}ms`),
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
    if (signal.aborted) {
      // Kalah sebelum stream mulai -> batalkan supaya tidak terus memakan neuron.
      await (stream as ReadableStream).cancel?.().catch(() => {});
      return { text: null, ms: Date.now() - t0 };
    }
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
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

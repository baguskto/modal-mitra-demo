// Bandingkan latensi model chat Kenari kandidat (HANYA model di scope_models paket Studio yang
// terbukti billing_kind "plan" di GET /v1/usage hari ini) dengan prompt realistis demo ini:
//  - "answer": system prompt asli + konteks RAG 3 chunk + pesan informal telat bayar, STREAMING
//    teks polos (bentuk jawaban akhir baru, lihat src/agent/graph.ts nodeTools) -> ukur TTFT & total.
//  - "classify": klasifikasi intent JSON pendek (non-streaming) -> ukur total.
// Batas panggilan: MODELS.length * (ANSWER_RUNS + 1) <= 20 (brief). Key dari env KENARI_API_KEY
// (diisi dari Keychain oleh pemanggil, tidak pernah dicetak). Jalankan:
//   KENARI_API_KEY=$(security find-generic-password -s kenari-api-key -w) npx tsx scripts/bench-models.ts
import { readFileSync, writeFileSync } from "node:fs";
import { buildSystemPrompt, buildStreamingAnswerTurn } from "../src/agent/prompts";
import { CLASSIFIER_SYSTEM_PROMPT } from "../src/agent/classify";

const KEY = process.env.KENARI_API_KEY;
if (!KEY) throw new Error("KENARI_API_KEY kosong");

// Ronde 1 (12 panggilan): 4 model x (2 answer + 1 classify) -> evals/model-bench-round1.json.
// Ronde 2 (6 panggilan, BENCH_ROUND=2): hanya answer, untuk memisahkan lonjakan sesaat dari baseline.
const ROUND2 = process.env.BENCH_ROUND === "2";
const MODELS: { id: string; reasoning?: string; runs?: number }[] = ROUND2
  ? [
      { id: "deepseek-v4-1-flash", reasoning: "none", runs: 3 },
      { id: "gpt-6-luna", reasoning: "none", runs: 2 },
      { id: "gpt-6-1-terra", reasoning: "none", runs: 1 },
    ]
  : [
      { id: "gpt-6-1-terra", reasoning: "none" },
      { id: "gpt-6-luna", reasoning: "none" },
      { id: "deepseek-v4-1-flash", reasoning: "none" },
      { id: "gemini-3-7-flash", reasoning: "low" },
    ];
const ANSWER_RUNS = 2;
const USER_TEXT = "aduh maap bu kemarin blm bisa bayar angsuran, gimana ya";

const chunks: { chunk_ref: string; text: string }[] = JSON.parse(readFileSync("data/synthetic/kb-chunks.json", "utf-8"));
const ctx = chunks
  .filter((c) => /keterlambatan|restrukturisasi|denda|angsuran/i.test(c.text))
  .slice(0, 3)
  .map((c) => `[${c.chunk_ref}] ${c.text}`)
  .join("\n---\n");

async function streamAnswer(model: string, reasoning?: string) {
  const t0 = Date.now();
  const res = await fetch("https://kenari.id/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 600,
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
      messages: [
        { role: "system", content: buildSystemPrompt("mitra", null, "Pengguna menulis informal; balas hangat dan sederhana.", "stream") },
        { role: "user", content: buildStreamingAnswerTurn(USER_TEXT, ctx, null) },
      ],
    }),
  });
  if (!res.ok || !res.body) return { ok: false, status: res.status, err: (await res.text()).slice(0, 200) };
  let ttft: number | null = null;
  let text = "";
  let usage: any = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta?.content;
        if (d) {
          if (ttft === null) ttft = Date.now() - t0;
          text += d;
        }
        if (j.usage) usage = j.usage;
      } catch {}
    }
  }
  return { ok: true, ttftMs: ttft, totalMs: Date.now() - t0, chars: text.length, usage, sample: text.slice(0, 160), citesKb: /\[[a-z0-9-]+#\d+\]/i.test(text) };
}

async function classify(model: string, reasoning?: string) {
  const t0 = Date.now();
  const res = await fetch("https://kenari.id/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 60,
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: USER_TEXT },
      ],
    }),
  });
  const body: any = await res.json().catch(() => null);
  return { ok: res.ok, totalMs: Date.now() - t0, out: body?.choices?.[0]?.message?.content?.slice(0, 120) ?? null, usage: body?.usage ?? null };
}

async function main() {
  const results: any[] = [];
  let calls = 0;
  for (const m of MODELS) {
    for (let i = 0; i < (m.runs ?? ANSWER_RUNS); i++) {
      calls++;
      const r = await streamAnswer(m.id, m.reasoning);
      results.push({ model: m.id, kind: "answer", ...r });
      console.log(m.id, "answer", JSON.stringify({ ttft: (r as any).ttftMs, total: (r as any).totalMs, ok: r.ok, cites: (r as any).citesKb, err: (r as any).err }));
    }
    if (ROUND2) continue;
    calls++;
    const c = await classify(m.id, m.reasoning);
    results.push({ model: m.id, kind: "classify", ...c });
    console.log(m.id, "classify", JSON.stringify({ total: c.totalMs, out: c.out }));
  }
  writeFileSync(ROUND2 ? "evals/model-bench-round2.json" : "evals/model-bench-round1.json", JSON.stringify({ measuredAt: new Date().toISOString(), calls, userText: USER_TEXT, results }, null, 2));
  console.log("calls:", calls);
}

main();

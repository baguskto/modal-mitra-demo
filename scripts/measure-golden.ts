// Ukur latensi per fase untuk 10 pesan golden, SEBELUM (main @ 32f80c6, disalin ke .baseline/) vs
// SESUDAH (branch ini), memanggil runAgentGraph LANGSUNG di Node — tanpa wrangler dev/deploy.
//
// Lingkungan yang SAMA untuk kedua implementasi (supaya selisihnya adil):
//  - D1: node:sqlite in-memory (schema + seed sintetis) + jeda D1_LATENCY_MS per query (default 8 ms,
//    mendekati D1 remote dari Durable Object).
//  - Kenari: panggilan NYATA (model plan; key dari env KENARI_API_KEY, diisi dari Keychain).
//  - Workers AI: TIDAK terjangkau dari Node -> stub. Llama Guard disimulasikan "safe" setelah
//    AI_GUARD_SIM_MS (default 400 ms); embedding & chat Workers AI selalu gagal (anggap kuota habis) ->
//    retrieval = BM25 lokal di kedua implementasi, hedge Workers AI tidak pernah menang (konservatif
//    untuk "sesudah": percepatan dari hedging TIDAK ikut terhitung di sini).
//  - Vectorize: stub yang gagal (tidak dipakai karena embedding gagal).
//
// Jalankan:
//   KENARI_API_KEY=$(security find-generic-password -s kenari-api-key -w) npx tsx scripts/measure-golden.ts new 2
//   KENARI_API_KEY=... npx tsx scripts/measure-golden.ts baseline 1
import { writeFileSync, mkdirSync } from "node:fs";
import { createD1 } from "./harness/d1shim";

const IMPL = (process.argv[2] ?? "new") as "new" | "baseline";
const REPS = Number(process.argv[3] ?? 1);
const D1_LATENCY_MS = Number(process.env.D1_LATENCY_MS ?? 8);
const AI_GUARD_SIM_MS = Number(process.env.AI_GUARD_SIM_MS ?? 400);
// CAPTURE=1 -> simpan rekaman giliran NYATA (event X-Ray + potongan teks ber-timestamp + meta) ke
// scripts/e2e/fixtures/<id>.json, diputar ulang oleh scripts/e2e/xray-local.spec.ts (Playwright).
// ONLY=g02_telat_informal,g03_verify_angsuran -> batasi kasus.
const CAPTURE = process.env.CAPTURE === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

export const GOLDEN: { id: string; persona: "mitra" | "pendana"; text: string; expectIntent?: string }[] = [
  { id: "g01_biaya_jasa", persona: "mitra", text: "Berapa biaya jasa pinjaman modal usaha mikro di sini?", expectIntent: "info" },
  { id: "g02_telat_informal", persona: "mitra", text: "aduh maap bu kemarin blm bisa bayar angsuran, gimana ya", expectIntent: "keterlambatan" },
  { id: "g03_verify_angsuran", persona: "mitra", text: "Cek sisa angsuran saya, nomor pinjaman MMK-100001 tanggal lahir saya 1985-03-12", expectIntent: "akun" },
  { id: "g04_majelis_verify", persona: "mitra", text: "Kapan pertemuan majelis saya selanjutnya, nomor pinjaman MMK-100002 tanggal lahir saya 1990-07-20", expectIntent: "akun" },
  { id: "g05_pendana_portofolio", persona: "pendana", text: "Cek portofolio pendanaan saya, ID pendana PND-0001 tanggal lahir saya 1992-01-15", expectIntent: "akun" },
  { id: "g06_imbal_hasil", persona: "pendana", text: "imbal hasil pendanaan di sini dijamin ga sih", expectIntent: "info" },
  { id: "g07_syarat_pengajuan", persona: "mitra", text: "Syarat pengajuan pinjaman baru apa saja, lewat siapa prosesnya?", expectIntent: "pengajuan" },
  { id: "g08_sla_pengaduan", persona: "mitra", text: "Pengaduan saya ditindaklanjuti paling lambat berapa hari kerja?", expectIntent: "pengaduan" },
  { id: "g09_keringanan_janji", persona: "mitra", text: "Pasti disetujui kan kalau saya minta keringanan?", expectIntent: "keterlambatan" },
  { id: "g10_sapaan_umum", persona: "mitra", text: "halo bu, mau tanya dong soal pinjaman modal buat warung", expectIntent: undefined },
];

function aiStub(): Ai {
  return {
    run: async (model: string, input: any) => {
      if (/llama-guard/.test(model)) {
        await new Promise((r) => setTimeout(r, AI_GUARD_SIM_MS));
        return { response: "safe" };
      }
      throw new Error("4006: workers ai tidak terjangkau dari harness Node (disimulasikan kuota habis)");
    },
  } as unknown as Ai;
}
const vectorizeStub = { query: async () => { throw new Error("vectorize stub"); } } as unknown as VectorizeIndex;

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

async function main() {
  if (!process.env.KENARI_API_KEY) throw new Error("KENARI_API_KEY kosong");
  const root = IMPL === "baseline" ? "../.baseline/src" : "../src";
  const graph = await import(`${root}/agent/graph.ts`);
  const lf = await import(`${root}/obs/langfuse.ts`);
  const audit = await import(`${root}/obs/audit.ts`);
  audit.configureAuditHmac("harness-local-hmac-key");

  const rows: any[] = [];
  for (let rep = 0; rep < REPS; rep++) {
    for (const g of GOLDEN) {
      if (ONLY && !ONLY.has(g.id)) continue;
      const db = createD1({ latencyMs: D1_LATENCY_MS });
      const env = {
        AI: aiStub(),
        VECTORIZE: vectorizeStub,
        DB: db,
        MODEL_PRIMARY: "@cf/qwen/qwen3-30b-a3b-fp8",
        MODEL_GUARD: "@cf/meta/llama-guard-3-8b",
        EMBED_MODEL: "@cf/baai/bge-m3",
        KENARI_API_KEY: process.env.KENARI_API_KEY,
        // Default = wrangler.toml [vars]. HEDGE_MODEL=none -> varian tanpa hedge Kenari kedua.
        KENARI_CHAT_MODEL: process.env.KENARI_CHAT_MODEL ?? "gpt-6-luna",
        KENARI_HEDGE_MODEL: process.env.HEDGE_MODEL === "none" ? undefined : process.env.HEDGE_MODEL ?? "deepseek-v4-1-flash",
        LLM_HEDGE_AFTER_MS: process.env.LLM_HEDGE_AFTER_MS ?? "1500",
        WORKERS_AI_RACE_AFTER_MS: process.env.WORKERS_AI_RACE_AFTER_MS ?? "0",
      };
      const events: any[] = [];
      const trace = lf.startTrace(null, "harness", {}, {}, undefined, undefined, (ev: any) => events.push(ev));
      const t0 = Date.now();
      let clientFirstTokenMs: number | null = null;
      const deltas: { atMs: number; len: number; text: string }[] = [];
      let replacedWith: { text: string; reason: string } | null = null;
      const sink = {
        text: (d: string) => {
          const at = Date.now() - t0;
          if (clientFirstTokenMs === null) clientFirstTokenMs = at;
          deltas.push({ atMs: at, len: d.length, text: d });
        },
        replace: (text: string, reason: string) => {
          replacedWith = { text, reason };
        },
      };
      const input = { sessionId: `harness-${IMPL}-${g.id}-${rep}`, persona: g.persona, userText: g.text, history: [], verifiedActorId: null, failedUnderstandingCount: 0, turnStartedAt: t0 };
      const out = IMPL === "baseline" ? await graph.runAgentGraph(env, input, trace) : await graph.runAgentGraph(env, input, trace, sink);
      const wallMs = Date.now() - t0;
      const phases: Record<string, number> = {};
      for (const ev of events) if (ev.phase === "end" && typeof ev.durationMs === "number") phases[ev.node] = (phases[ev.node] ?? 0) + ev.durationMs;
      // Sebelum: jawaban baru direlai setelah graph selesai (first-token == total, lihat timing lama).
      const firstTokenMs = IMPL === "baseline" ? out.timing.firstTokenMs ?? wallMs : out.timing.firstTokenMs ?? clientFirstTokenMs ?? wallMs;
      const row = {
        id: g.id,
        rep,
        intent: out.intent,
        intentOk: g.expectIntent ? out.intent === g.expectIntent : true,
        model: out.modelUsed,
        blockedByGuard: out.blockedByGuard ?? null,
        tools: out.toolCallsMade.map((t: any) => t.tool),
        firstTokenMs,
        totalMs: out.timing.totalMs ?? wallMs,
        wallMs,
        streamedChunks: deltas.length,
        phases,
        answer: String(out.answerText).slice(0, 140).replace(/\s+/g, " "),
      };
      rows.push(row);
      if (CAPTURE && IMPL === "new") {
        mkdirSync("scripts/e2e/fixtures", { recursive: true });
        const meta = { citations: out.citations, intent: out.intent, blockedByGuard: out.blockedByGuard ?? null, modelRefused: out.modelRefused, replaced: out.replaced, timing: out.timing, modelUsed: out.modelUsed, toolCallsMade: out.toolCallsMade, xray: events, traceId: "harness" };
        writeFileSync(`scripts/e2e/fixtures/${g.id}.json`, JSON.stringify({ id: g.id, persona: g.persona, userText: g.text, deltas, replacedWith, meta }, null, 1));
      }
      console.log(`${IMPL} ${g.id}#${rep} intent=${row.intent}${row.intentOk ? "" : "(!)"} first=${row.firstTokenMs} total=${row.totalMs} model=${row.model} tools=${row.tools.join("+") || "-"} phases=${JSON.stringify(phases)}`);
    }
  }
  const ft = rows.map((r) => r.firstTokenMs).sort((a, b) => a - b);
  const tt = rows.map((r) => r.totalMs).sort((a, b) => a - b);
  const phaseNames = [...new Set(rows.flatMap((r) => Object.keys(r.phases)))];
  const phaseP50: Record<string, number> = {};
  for (const p of phaseNames) phaseP50[p] = pct(rows.map((r) => r.phases[p] ?? 0).sort((a, b) => a - b), 50);
  const summary = {
    impl: IMPL,
    hedgeModel: IMPL === "new" ? (process.env.HEDGE_MODEL === "none" ? null : process.env.HEDGE_MODEL ?? "deepseek-v4-1-flash") : null,
    measuredAt: new Date().toISOString(),
    env: { D1_LATENCY_MS, AI_GUARD_SIM_MS, workersAi: "stub (tidak terjangkau dari Node)", retrieval: "BM25 lokal (kedua implementasi)" },
    n: rows.length,
    firstTokenMs: { p50: pct(ft, 50), p95: pct(ft, 95), min: ft[0], max: ft[ft.length - 1] },
    totalMs: { p50: pct(tt, 50), p95: pct(tt, 95), min: tt[0], max: tt[tt.length - 1] },
    phaseP50,
    intentAccuracy: `${rows.filter((r) => r.intentOk).length}/${rows.length}`,
    rows,
  };
  const variant = IMPL === "new" && process.env.HEDGE_MODEL === "none" ? "-nohedge" : "";
  if (!ONLY) writeFileSync(`evals/latency-golden-${IMPL}${variant}.json`, JSON.stringify(summary, null, 2));
  console.log(`\n${IMPL}: first-token p50=${summary.firstTokenMs.p50} p95=${summary.firstTokenMs.p95} | total p50=${summary.totalMs.p50} p95=${summary.totalMs.p95} | intent ${summary.intentAccuracy}`);
  console.log("phase p50:", JSON.stringify(phaseP50));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

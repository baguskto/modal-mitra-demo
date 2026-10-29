// Ukur latensi first-token & total terhadap worker yang sudah dideploy, memakai field `timing`
// yang dikembalikan tiap respons /api/chat/:sessionId/message (lihat src/agent/toolAgent.ts).
// "first-token" = waktu sampai teks LOLOS guard & mulai direlai ke pengguna (lihat README
// §Keputusan Desain soal kenapa bukan token mentah dari model). Jalankan:
//   npx tsx scripts/measure-latency.ts [base_url]
import { writeFileSync } from "node:fs";

const BASE_URL = process.argv[2] || process.env.MMK_BASE_URL || "https://modal-mitra-demo.markas-auracheck.workers.dev";

interface Case {
  label: string;
  persona: "mitra" | "pendana";
  text: string;
}

const CASES: Case[] = [
  { label: "rag_simple", persona: "mitra", text: "Berapa biaya jasa pinjaman modal usaha mikro di sini?" },
  { label: "verify_plus_lookup", persona: "mitra", text: "Cek sisa angsuran saya, nomor pinjaman MMK-100001 tanggal lahir saya 1985-03-12" },
  { label: "majelis_schedule", persona: "mitra", text: "Kapan pertemuan majelis saya selanjutnya, nomor pinjaman MMK-100002 tanggal lahir saya 1990-07-20" },
  { label: "pendana_portfolio", persona: "pendana", text: "Cek portofolio pendanaan saya, ID pendana PND-0001 tanggal lahir saya 1992-01-15" },
  { label: "guard_blocked_scope", persona: "mitra", text: "Siapa presiden Indonesia saat ini?" },
  { label: "handoff_explicit", persona: "mitra", text: "Saya mau bicara dengan CS manusia saja" },
];

const REPEATS = 3;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  const results: { label: string; firstTokenMs: number | null; totalMs: number; blockedByGuard?: string }[] = [];

  for (const c of CASES) {
    for (let r = 0; r < REPEATS; r++) {
      const sessionId = `latency-${c.label}-${r}-${Date.now().toString(36)}`;
      const startedAt = Date.now();
      const res = await fetch(`${BASE_URL}/api/chat/${encodeURIComponent(sessionId)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: c.text, persona: c.persona }),
      });
      const data: any = await res.json();
      const wallMs = Date.now() - startedAt;
      results.push({
        label: c.label,
        firstTokenMs: data?.timing?.firstTokenMs ?? null,
        totalMs: data?.timing?.totalMs ?? wallMs,
        blockedByGuard: data?.blockedByGuard,
      });
      console.log(`${c.label} #${r + 1}: firstToken=${data?.timing?.firstTokenMs}ms total=${data?.timing?.totalMs}ms${data?.blockedByGuard ? ` (guard:${data.blockedByGuard})` : ""}`);
    }
  }

  const firstTokens = results.map((r) => r.firstTokenMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const totals = results.map((r) => r.totalMs).sort((a, b) => a - b);

  const summary = {
    baseUrl: BASE_URL,
    measuredAt: new Date().toISOString(),
    n: results.length,
    firstTokenMs: { p50: percentile(firstTokens, 50), p95: percentile(firstTokens, 95), min: firstTokens[0], max: firstTokens[firstTokens.length - 1] },
    totalMs: { p50: percentile(totals, 50), p95: percentile(totals, 95), min: totals[0], max: totals[totals.length - 1] },
    byCase: results,
  };

  writeFileSync("evals/latency-results.json", JSON.stringify(summary, null, 2));
  console.log("\n=== RINGKASAN ===");
  console.log(`first-token p50=${summary.firstTokenMs.p50}ms p95=${summary.firstTokenMs.p95}ms`);
  console.log(`total       p50=${summary.totalMs.p50}ms p95=${summary.totalMs.p95}ms`);
  console.log("Ditulis ke evals/latency-results.json");
}

main();

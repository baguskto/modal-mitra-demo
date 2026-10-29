// Runbook deploy satu-perintah (temuan QA prioritas #4) -- lihat README "Runbook deploy aman".
// Urutan: cek login wrangler -> migrasi D1 IDEMPOTEN (ALTER hanya bila kolom belum ada) -> deploy
// Worker -> reseed data sintetis (aman, tidak menyentuh tabel sesi/audit/tiket) -> purge sesi eval
// dari antrean live. Setiap langkah berhenti (exit 1) kalau gagal, supaya tidak lanjut ke langkah
// berikutnya dengan state yang tidak konsisten.
//
// Jalankan: npm run deploy:all

import { execSync } from "node:child_process";

function run(cmd: string, opts: { allowFail?: boolean } = {}): string {
  console.log(`\n$ ${cmd}`);
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"] });
  } catch (err: any) {
    if (opts.allowFail) return String(err?.stdout ?? "");
    console.error(err?.stdout ?? err?.message ?? err);
    process.exit(1);
  }
}

function d1Json(sql: string): any {
  const out = run(`npx wrangler d1 execute modal_mitra_db --remote --json --command "${sql.replace(/"/g, '\\"')}"`);
  try {
    return JSON.parse(out);
  } catch {
    console.error("Gagal parse output JSON dari wrangler d1 execute:", out);
    process.exit(1);
  }
}

function columnExists(table: string, column: string): boolean {
  const parsed = d1Json(`SELECT COUNT(*) as n FROM pragma_table_info('${table}') WHERE name='${column}'`);
  const n = parsed?.[0]?.results?.[0]?.n ?? 0;
  return n > 0;
}

function main() {
  console.log("=== 1/5: Cek login wrangler ===");
  const whoami = run("npx wrangler whoami", { allowFail: true });
  if (!whoami || /not logged in/i.test(whoami) || /failed to fetch auth token/i.test(whoami)) {
    console.error(
      "\n[GAGAL] wrangler belum/tidak bisa login. Jalankan `npx wrangler login` (atau set env CLOUDFLARE_API_TOKEN) dulu, lalu ulangi `npm run deploy:all`.\n" +
        "Output whoami:\n" +
        whoami,
    );
    process.exit(1);
  }
  console.log(whoami);

  console.log("\n=== 2/5: Migrasi D1 idempotent (ALTER TABLE hanya bila kolom belum ada) ===");
  if (!columnExists("sessions_index", "source")) {
    console.log("Menambah kolom sessions_index.source ...");
    run(`npx wrangler d1 execute modal_mitra_db --remote --command "ALTER TABLE sessions_index ADD COLUMN source TEXT NOT NULL DEFAULT 'live'"`);
  } else {
    console.log("Kolom sessions_index.source sudah ada, skip.");
  }
  if (!columnExists("restructuring_requests", "first_approver")) {
    console.log("Menambah kolom restructuring_requests.first_approver ...");
    run(`npx wrangler d1 execute modal_mitra_db --remote --command "ALTER TABLE restructuring_requests ADD COLUMN first_approver TEXT"`);
  } else {
    console.log("Kolom restructuring_requests.first_approver sudah ada, skip.");
  }

  console.log("\n=== 3/5: Deploy Worker (build:ui + wrangler deploy) ===");
  run("npm run deploy");

  console.log(
    "\n=== 4/5: Reseed data sintetis (AMAN -- data/synthetic/seed.sql hanya DELETE+INSERT ulang " +
      "majelis/mitra/pinjaman/angsuran/pendana/pendanaan/kb_documents; TIDAK pernah menyentuh " +
      "sessions_index/audit_log/tickets/dsr_requests/restructuring_requests, jadi sesi/riwayat chat " +
      "live & approval HITL yang sedang berjalan TIDAK hilang) ===",
  );
  run("npm run seed:remote");

  console.log("\n=== 5/5: Purge sesi eval dari antrean live (temuan QA #4/#8) ===");
  run(`npx wrangler d1 execute modal_mitra_db --remote --command "DELETE FROM sessions_index WHERE source = 'eval'"`);

  console.log(
    "\n✅ Deploy selesai. Smoke test manual yang disarankan (lihat README §Runbook deploy aman):\n" +
      "  1. Chat publik 1 giliran (quick-fill apa saja) -> balasan muncul, tidak ada error console.\n" +
      "  2. Konsol CS publik -> hanya lihat sesi sendiri, bukan sesi orang lain.\n" +
      "  3. Presenter: approve 1 permintaan HITL dengan 2 identitas CS berbeda -> submitted; identitas sama 2x -> 409.\n" +
      "  4. /learn publik -> level 10 tanpa merek, tidak ada Q&A interview tampil.\n" +
      "  5. Konsol CS Presenter: Verifikasi integritas log -> VALID; Demo tamper -> Verifikasi lagi -> RUSAK.\n",
  );
}

main();

// Guard 1: redaksi PII sebelum teks masuk ke LLM.
// Prinsip: LLM tidak pernah melihat nilai asli. Mapping token<->asli disimpan di memori
// Durable Object (bukan dikirim ke LLM, bukan ditulis mentah ke audit log).

export interface PiiMatch {
  token: string;
  type: string;
  original: string;
}

const PATTERNS: { type: string; re: RegExp }[] = [
  { type: "NIK", re: /\b\d{16}\b/g },
  { type: "PINJAMAN", re: /\bMMK-\d{6}\b/gi },
  { type: "PENDANA_ID", re: /\bPND-\d{4}\b/gi },
  { type: "KARTU", re: /\b(?:\d[ -]?){13,19}\b/g },
  { type: "EMAIL", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { type: "HP", re: /\b(?:\+62|62|0)8\d{8,11}\b/g },
  // Tanggal lahir (faktor verifikasi ke-2) SENGAJA diredaksi juga — temuan review: faktor
  // verifikasi kedua tidak boleh terkirim mentah ke LLM/model guard/audit log sama seperti
  // nomor pinjaman/ID pendana. Token tetap di-resolve balik lewat vault sebelum eksekusi tool.
  { type: "TANGGAL", re: /\b\d{4}-\d{2}-\d{2}\b/g },
  // FIX (temuan QA #g): format ISO di atas TIDAK menangkap tanggal lahir yang ditulis informal
  // ("tgl lahir 12/03/1985", "12 maret 1985") -- sebelumnya bocor mentah ke audit log
  // `query_redacted` (terbaca publik via Konsol CS -> "Trace audit log", token demo). Dua pola
  // tambahan: DD/MM/YYYY atau DD-MM-YYYY, dan "DD <nama bulan> YYYY" (Bahasa Indonesia).
  { type: "TANGGAL", re: /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/g },
  { type: "TANGGAL", re: /\b\d{1,2}\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}\b/gi },
];

// Scan OUTPUT (jawaban ke pengguna) HANYA untuk PII yang berbahaya ditampilkan ke SIAPAPUN, tanpa
// terkecuali — nomor pinjaman/ID pendana/tanggal TIDAK dimasukkan di sini: itu normal & diharapkan
// saat bot mengonfirmasi balik data milik PENGGUNA SENDIRI (mis. "Pinjaman MMK-100001 Anda...",
// "jatuh tempo 2026-11-03"), dan kebocoran data MILIK PIHAK LAIN untuk field itu sudah ditangani
// lebih presisi oleh checkMemberPrivacyLeak (groundedness, lihat guards/output.ts) — bukan larangan
// buta terhadap pola tanggal/ID apa pun yang akan salah-blokir jawaban sah (ditemukan sendiri saat
// uji ulang MAX_STEPS: due date/meeting date di jawaban legitimate ikut tertangkap pola TANGGAL).
const OUTPUT_LEAK_PATTERNS = PATTERNS.filter((p) => ["NIK", "KARTU", "EMAIL", "HP"].includes(p.type));

export function redactPII(text: string): { redacted: string; matches: PiiMatch[] } {
  let redacted = text;
  const matches: PiiMatch[] = [];
  let counter = 0;
  for (const { type, re } of PATTERNS) {
    redacted = redacted.replace(re, (m) => {
      counter += 1;
      const token = `[${type}_${counter}]`;
      matches.push({ token, type, original: m });
      return token;
    });
  }
  return { redacted, matches };
}

/**
 * FIX (re-test live pasca-deploy 30 Okt): histori percakapan (fix B3) dikirim ke LLM sebagai teks
 * MENTAH -- nomor pinjaman/tanggal lahir yang pernah diketik user ikut terkirim ke LLM di giliran
 * berikutnya, melanggar prinsip "LLM tidak pernah melihat nilai asli". Histori di-mask dengan token
 * ber-indeks 0 ("[PINJAMAN_0]"): tidak pernah ada di vault (counter mulai 1), jadi tidak bisa
 * di-resolve ke nilai asli, dan kalau LLM menyalinnya ke jawaban, resolveLeakedTokensInText
 * menghapusnya. `maskDates=false` untuk balasan asisten (jatuh tempo/jadwal majelis tetap terbaca).
 */
export function maskPIIForHistory(text: string, maskDates: boolean): string {
  let out = text;
  for (const { type, re } of PATTERNS) {
    if (type === "TANGGAL" && !maskDates) continue;
    out = out.replace(re, `[${type}_0]`);
  }
  return out;
}

/**
 * Temuan review: LLM kadang MENYALIN token redaksi ("[PINJAMAN_1]") langsung ke jawaban akhir
 * alih-alih nilai asli (model melihat token tersebut di konteks giliran ini). Jawaban ke pengguna
 * TIDAK PERNAH boleh menampilkan token mentah — ganti balik ke nilai asli dari vault giliran ini
 * sebelum dikirim; jika tokennya sudah tidak ada di vault (kasus langka), hapus saja token itu
 * daripada menampilkan artefak internal ke pengguna.
 */
export function resolveLeakedTokensInText(text: string, vault: Map<string, string>): string {
  return text.replace(/\[[A-Z_]+_\d+\]/g, (token) => vault.get(token) ?? "");
}

/**
 * Tool args yang diisi LLM bisa saja berupa token (karena itulah yang LLM "lihat" di konteks),
 * misalnya contract_no="[KONTRAK_1]". Sebelum eksekusi tool, token di-resolve balik ke nilai asli
 * memakai vault sesi (tidak pernah dikirim ke LLM, hanya hidup di memori Worker selama 1 giliran).
 */
export function resolveTokens(args: Record<string, any>, vault: Map<string, string>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && vault.has(v) ? vault.get(v)! : v;
  }
  return out;
}

/** Scan output LLM sebelum dikirim ke nasabah: pastikan tidak ada PII mentah yang lolos. */
export function scanOutputForPII(text: string): { clean: boolean; findings: string[] } {
  const findings: string[] = [];
  for (const { type, re } of OUTPUT_LEAK_PATTERNS) {
    const found = text.match(re);
    if (found) findings.push(`${type}: ${found.length} kemunculan`);
  }
  return { clean: findings.length === 0, findings };
}

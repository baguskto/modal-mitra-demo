// Guard 3: klasifikasi cakupan. Menolak sopan untuk topik di luar layanan PT Dana Contoh Finance.
// Heuristik keyword dulu (deterministik, cepat, mudah dites); dirancang agar permisif terhadap
// bahasa informal (bukan over-refuse) tapi tegas terhadap topik yang jelas tidak relevan.

const IN_SCOPE_KEYWORDS = [
  "angsuran", "cicilan", "pinjaman", "pendanaan", "modal usaha", "majelis", "kelompok",
  "pertemuan", "petugas lapangan", "pengajuan", "top up", "top-up", "plafon",
  "pengaduan", "komplain", "keluhan", "penagihan", "dc", "debt collector", "restrukturisasi",
  "data pribadi", "pdp", "hapus data", "ojk", "lpbbti", "afpi", "pelunasan", "tenor",
  "cs", "customer service", "akun saya", "mitra", "pendana", "portofolio", "portfolio",
  "pencairan", "imbal hasil", "risiko", "risk", "investasi", "p2p", "leasing", "finance",
];

const CLEARLY_OUT_OF_SCOPE = [
  /resep (makanan|masakan)/i,
  /tulis(kan)? (puisi|cerita|lagu|kode|program)/i,
  /ibu ?kota/i,
  /cuaca (hari ini|besok)/i,
  /siapa presiden/i,
  /write (me )?a (poem|story|song|essay)/i,
  /\bcode\b.*\b(python|javascript|function)\b/i,
];

export interface ScopeResult {
  inScope: boolean;
  reason?: string;
}

export function checkScope(text: string): ScopeResult {
  const lower = text.toLowerCase();
  for (const re of CLEARLY_OUT_OF_SCOPE) {
    if (re.test(lower)) return { inScope: false, reason: "Topik jelas di luar layanan Modal Mitra Contoh" };
  }
  const hasInScopeSignal = IN_SCOPE_KEYWORDS.some((k) => lower.includes(k));
  if (hasInScopeSignal) return { inScope: true };
  // Pesan singkat/sapaan/ambigu tetap diperbolehkan masuk ke router (akan ditangani sebagai smalltalk/klarifikasi),
  // hanya topik yang JELAS tidak relevan yang ditolak di guard ini -> menghindari over-refuse.
  return { inScope: true };
}

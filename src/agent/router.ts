export type Persona = "mitra" | "pendana" | "petugas";
export type Intent = "info" | "akun" | "pengajuan" | "keterlambatan" | "pengaduan" | "hak_data" | "lain";

// feat/latency-xray: kasus nyata dari demo 2 Nov ("aduh maap bu kemarin blm bisa bayar angsuran,
// gimana ya") jatuh ke intent "lain" karena regex lama hanya mengenal kata baku (telat/nunggak/...).
// Sekarang dua pola: kata kunci keterlambatan + negasi informal ("blm/ga/gak/nggak/tdk ... bisa/
// sanggup/ada uang ... bayar/setor/nyicil"). Model cepat (classify.ts) tetap jadi cadangan untuk
// "lain" yang tersisa.
const LATE_KEYWORDS = /(telat|terlambat|nunggak|menunggak|macet bayar|susah bayar|keringanan|restrukturisasi|perpanjang tenor|tunda (bayar|angsuran|setoran)|minta (waktu|tempo)|lagi (seret|susah)|ga ada uang|gak ada uang|nggak ada uang|tidak ada uang|belum ada uang|blm ada uang|tidak sanggup|ga sanggup|gak sanggup)/;
const LATE_NEGATED_PAY = /\b(belum|blm|blom|ga|gak|ngga|nggak|enggak|engga|tidak|tdk|gk)\b\s+(\w+\s+){0,3}?(bayar|byr|setor|nyetor|nyicil|mencicil|angsur)/;

export function classifyIntent(text: string, persona: Persona): Intent {
  const t = text.toLowerCase();
  if (/(hapus data|data.*dihapus|dihapus.*data|\bdihapus\b|akses data|koreksi data|data pribadi saya|hak subjek data|\bdsr\b)/.test(t)) return "hak_data";
  if (/(pengaduan|komplain|keluhan|penagihan kasar|dc kasar|ancam|mengancam|intimidasi)/.test(t)) return "pengaduan";
  if (persona === "mitra" && (LATE_KEYWORDS.test(t) || LATE_NEGATED_PAY.test(t))) return "keterlambatan";
  if (persona === "mitra" && /(ajukan|pengajuan|top ?up|pinjam lagi|tambah plafon|pinjaman baru)/.test(t)) return "pengajuan";
  if (/(angsuran (saya|sy|aku|ku)|cicilan (saya|sy|aku|ku)|sisa angsuran|status pinjaman|cek pinjaman|akun saya|jadwal majelis|pertemuan majelis|portofolio saya|pendanaan saya|pencairan saya|status dana)/.test(t)) return "akun";
  if (/(denda|bunga|biaya jasa|tenor|syarat|produk|plafon|pelunasan|risiko|imbal hasil|risk tier)/.test(t)) return "info";
  return "lain";
}

export interface HitlTrigger {
  shouldHandoff: boolean;
  reason?: string;
  severity: "normal" | "high" | "critical";
}

const CRITICAL_KEYWORDS = /(ancam|kekerasan|intimidasi|lapor hukum|pengacara|\bojk\b|\bafpi\b)/i;
const NEGATIVE_SENTIMENT = /(kasar|brutal|ga manusiawi|tidak manusiawi|parah banget|kecewa berat|anjing|bangsat)/i;

export function detectHitl(text: string, failedUnderstandingCount: number, explicitHumanRequest: boolean): HitlTrigger {
  if (explicitHumanRequest) return { shouldHandoff: true, reason: "Permintaan eksplisit bicara dengan manusia", severity: "normal" };
  if (CRITICAL_KEYWORDS.test(text)) return { shouldHandoff: true, reason: "Kata kunci kritis (ancaman/OJK/hukum) terdeteksi", severity: "critical" };
  if (NEGATIVE_SENTIMENT.test(text)) return { shouldHandoff: true, reason: "Sentimen sangat negatif terdeteksi", severity: "high" };
  if (failedUnderstandingCount >= 2) return { shouldHandoff: true, reason: "AI gagal memahami maksud pengguna 2x berturut-turut", severity: "normal" };
  return { shouldHandoff: false, severity: "normal" };
}

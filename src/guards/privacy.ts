// Guard tambahan (re-test live 30 Okt, Red Team "PII exfil data mitra lain"): permintaan NIK/nomor
// HP/alamat/KTP milik ORANG LAIN sebelumnya lolos ke LLM, yang lalu "kebetulan" mengalihkan ke CS
// -- data tidak bocor, tapi Red Team Arena menilainya "TIDAK TERTANGKAP" (ASR 1/8) dan perilakunya
// bergantung pada mood model. Ditolak deterministik di guard_in (sebelum LLM). Hanya aktif kalau ada
// penanda pihak lain (ID MIT-xxxx, "mitra/anggota/nasabah lain", "milik/punya/atas nama <Nama>"),
// jadi "NIK saya" / "ganti nomor HP saya" tidak ikut terblokir.
const PII_FIELD = /\b(nik|ktp|no(mor)?\.?\s*(hp|handphone|telepon|telp|wa|whatsapp|rekening)|alamat)\b/i;
const THIRD_PARTY = [
  /\bMIT-\d{4}\b/i,
  /\bPND-\d{4}\b/i,
  /\b(mitra|anggota|nasabah|peminjam|pendana|orang)\s+lain\b/i,
  /\b(milik|punya|atas nama)\s+(?!saya\b|sy\b|aku\b|ku\b)[A-Z][a-z]+/,
  /\b(nik|ktp|hp|telepon|alamat)\b.{0,25}\b(lengkap\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+/,
];

export function checkThirdPartyPiiRequest(text: string): { blocked: boolean; reason?: string } {
  if (!PII_FIELD.test(text)) return { blocked: false };
  const hit = THIRD_PARTY.find((re) => re.test(text));
  return hit ? { blocked: true, reason: `Permintaan PII pihak lain (pola: ${hit.source})` } : { blocked: false };
}

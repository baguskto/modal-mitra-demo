// Guard tambahan (temuan QA M2): permintaan MENGHAPUS/MENGUBAH riwayat transaksi atau status
// pembayaran TIDAK PERNAH boleh "dipertimbangkan" oleh LLM sama sekali — sistem ini sengaja TIDAK
// punya tool UPDATE/DELETE untuk tabel inti (lihat README §10 Integritas data), tapi tanpa guard
// deterministik, LLM bisa menjawab dengan nada menyetujui ("Bisa, Bu...") sebelum akhirnya tidak
// benar-benar mengeksekusi apa pun -- nadanya tetap terdengar seperti komplain/kerentanan ke
// pewawancara. Blok di sini (guard_in, SEBELUM LLM) dengan alasan jelas (integritas data), supaya
// penolakannya deterministik & bisa diuji presisi (promptfoo), bukan bergantung ke "mood" model.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\b(hapus|delete|hilangkan)\b.{0,30}\b(riwayat|histori|history|catatan|data)\b.{0,30}\b(angsuran|pinjaman|keterlambatan|telat|transaksi|pembayaran)\b/i,
  /\b(ubah|ganti|edit|tandai)\b.{0,30}\bstatus(nya)?\b.{0,20}\b(lunas|selesai)\b/i,
  /\b(hapus|hilangkan|batalkan)\b.{0,30}\b(keterlambatan|telat|denda)\b/i,
  /\bbatalkan\b.{0,20}\b(denda|keterlambatan)\b/i,
];

export interface DataIntegrityResult {
  blocked: boolean;
  reason?: string;
}

export function checkDataIntegrityAbuse(text: string): DataIntegrityResult {
  for (const re of DESTRUCTIVE_PATTERNS) {
    if (re.test(text)) {
      return { blocked: true, reason: `Permintaan hapus/ubah data transaksi terdeteksi (pola: ${re.source})` };
    }
  }
  return { blocked: false };
}

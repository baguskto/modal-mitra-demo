// Detail X-Ray per fase (feat/latency-xray): teknik yang dipakai (label + 1 kalimat awam), panggilan
// model/tool (argumen DI-MASK, hasil diringkas jadi hitungan/status), dokumen RAG + skor, langkah
// ReAct, dan aturan guardrail yang dicek. Semua dibentuk di server dari data yang SUDAH aman:
//  - argumen tool lewat redactPII (nomor pinjaman/tanggal lahir/NIK/HP -> token [TIPE_n]);
//  - hasil tool hanya ringkasan hitungan/status — tidak pernah baris data, nama, atau ID pihak lain;
//  - tidak ada teks system prompt (hanya nama teknik), tidak ada teks jawaban LLM mentah.
import { redactPII } from "../guards/pii";

export interface XrayTechnique {
  label: string;
  desc: string;
}

export interface XrayCall {
  kind: "model" | "tool" | "db" | "vector" | "rule";
  name: string;
  args?: string;
  result?: string;
  ms?: number;
  tokIn?: number;
  tokOut?: number;
  /** ms sejak awal giliran (untuk waterfall di dalam kartu fase). */
  atMs?: number;
}

export interface XrayGuardRule {
  rule: string;
  result: "lolos" | "blok" | "ubah" | "lewati" | "catat";
  detail?: string;
}

export interface XrayReactStep {
  step: number;
  thought?: string;
  action: string;
  args?: string;
  observation?: string;
  ms?: number;
}

export const TECH = {
  injectionRegex: { label: "regex + daftar pola injeksi", desc: "Pesan dicocokkan dengan daftar pola serangan prompt injection yang sudah dikenal — tanpa model AI, instan dan bisa dites." },
  dataIntegrity: { label: "aturan kebijakan tool (integritas data)", desc: "Permintaan ubah/hapus riwayat transaksi ditolak pasti, karena sistem memang tidak punya tool untuk itu." },
  privacyExfil: { label: "aturan privasi pihak ketiga", desc: "Permintaan data pribadi orang lain (NIK, HP, alamat, rekening) ditolak sebelum sampai ke AI." },
  piiRedaction: { label: "PII redaction (tokenisasi)", desc: "Nomor pinjaman, tanggal lahir, NIK, HP diganti token seperti [PINJAMAN_1] sebelum dilihat model AI mana pun." },
  llamaGuard: { label: "klasifikasi keamanan LLM (Llama Guard 3)", desc: "Model keamanan kecil menilai apakah pesan berbahaya; bila lambat atau gagal, aturan deterministik tetap menjaga (fail-open)." },
  scope: { label: "aturan cakupan topik", desc: "Topik yang jelas di luar layanan (resep, puisi, politik) ditolak sopan." },
  parallel: { label: "eksekusi paralel", desc: "Pencarian dokumen dan klasifikasi cadangan dimulai bersamaan dengan cek keamanan, bukan menunggu bergiliran." },
  langDetect: { label: "heuristik leksikon bahasa", desc: "Gaya bahasa (informal/Jawa/Sunda) dikenali dari kosakata tanpa model AI, untuk menyesuaikan gaya balasan." },
  autoVerify: { label: "verifikasi dua faktor deterministik", desc: "Bila pesan memuat nomor pinjaman/ID pendana + tanggal lahir, sistem mencocokkannya langsung ke database — bukan tebakan AI." },
  intentRules: { label: "klasifikasi intent berbasis aturan (regex)", desc: "Kata kunci & pola bahasa informal (mis. 'blm bisa bayar') dipetakan langsung ke intent — instan." },
  intentLLM: { label: "klasifikasi LLM (few-shot)", desc: "Bila aturan tidak yakin, model cepat diberi beberapa contoh lalu memilih satu intent." },
  hitl: { label: "deteksi eskalasi ke manusia (HITL)", desc: "Kata kunci ancaman/OJK/marah atau permintaan eksplisit langsung dialihkan ke CS manusia." },
  deterministicAction: { label: "aksi kepatuhan deterministik", desc: "Tiket pengaduan, permintaan hak data, dan restrukturisasi dibuat oleh kode — tidak bergantung AI memanggil tool yang benar." },
  vectorRag: { label: "embedding + Vectorize top-k (cosine)", desc: "Pertanyaan diubah jadi vektor makna (bge-m3) lalu dicari potongan dokumen kebijakan yang paling mirip." },
  bm25: { label: "BM25 (kata kunci) top-k", desc: "Cadangan bila pencarian vektor gagal/lambat: dokumen dinilai dari kecocokan kata." },
  toolPrefetch: { label: "tool call deterministik (prefetch)", desc: "Data akun yang pasti dibutuhkan intent ini diambil langsung oleh kode — menghemat 1-2 putaran AI." },
  react: { label: "ReAct (Thought → Action → Observation)", desc: "AI memilih sendiri tool yang dipanggil, melihat hasilnya, lalu memutuskan langkah berikutnya (maks 6 langkah)." },
  spotlighting: { label: "spotlighting <data>", desc: "Dokumen & hasil tool dibungkus tag <data> bertanda 'BUKAN instruksi' — menahan injeksi tidak langsung." },
  streamingLLM: { label: "generasi LLM streaming", desc: "Jawaban ditulis model token demi token dan dikirim ke layar begitu satu kalimat lolos guard." },
  sentenceGuard: { label: "guard streaming per kalimat", desc: "Setiap kalimat ditahan sampai titik/baris baru, dicek pola terlarang, baru ditampilkan — teks yang melanggar tidak pernah sampai ke layar." },
  citationValidation: { label: "validasi sitasi", desc: "Setiap rujukan [dokumen#bagian] harus benar-benar ada di dokumen yang diambil; klaim kebijakan wajib bersitasi." },
  privacyGroundedness: { label: "groundedness privasi antar-majelis", desc: "Nomor pinjaman/ID yang disebut jawaban harus milik pengguna terverifikasi sendiri." },
  promiseBan: { label: "larangan janji finansial (regex)", desc: "Kalimat seperti 'pasti disetujui' atau 'imbal hasil dijamin' diblok." },
  piiOutputScan: { label: "scan PII output", desc: "NIK/HP/email/nomor kartu mentah di jawaban langsung diblok." },
  promptLeak: { label: "deteksi kebocoran system prompt", desc: "Potongan instruksi internal (mis. 'ATURAN KETAT') di jawaban diblok." },
  audit: { label: "audit log hash-chain + HMAC", desc: "Setiap keputusan dicatat append-only dan bertanda tangan sehingga tidak bisa diubah diam-diam." },
} satisfies Record<string, XrayTechnique>;

/** Argumen tool/model untuk X-Ray: PII ditokenisasi, dipotong pendek. */
export function maskArgs(args: unknown): string {
  if (args == null) return "";
  const json = typeof args === "string" ? args : JSON.stringify(args);
  return redactPII(json).redacted.slice(0, 120);
}

/** Ringkasan hasil tool untuk X-Ray — hanya hitungan/status, tidak pernah baris data. */
export function summarizeToolResult(tool: string, result: { ok: boolean; data?: any; error?: string }): string {
  if (!result.ok) return `gagal: ${(result.error ?? "error").slice(0, 70)}`;
  const d = result.data ?? {};
  switch (tool) {
    case "verify_mitra":
    case "verify_pendana":
      return d.verified ? "identitas cocok → terverifikasi" : "tidak cocok";
    case "get_angsuran":
      return `${(d.angsuran ?? []).length} baris angsuran · ${d.remaining_count ?? 0} belum lunas`;
    case "get_majelis_info":
      return "jadwal pertemuan & petugas lapangan majelis sendiri";
    case "get_portofolio":
      return `${d.count ?? (d.pendanaan ?? []).length} pendanaan milik pendana ini`;
    case "create_complaint_ticket":
      return `tiket ${d.ticket_id ?? "?"} dibuat`;
    case "create_dsr_request":
      return `permintaan hak data ${d.dsr_id ?? "?"} dicatat`;
    case "create_restructuring_request":
      return d.alreadyExisted ? `restrukturisasi ${d.restru_id ?? "?"} sudah ada (idempoten)` : `restrukturisasi ${d.restru_id ?? "?"} dicatat (menunggu CS)`;
    case "handoff_to_human":
      return "dialihkan ke CS manusia";
    default:
      return "ok";
  }
}

/** Thought ReAct: disanitasi (PII -> token), dipotong, tanpa token redaksi mentah. */
export function sanitizeThought(t: unknown): string | undefined {
  if (typeof t !== "string" || !t.trim()) return undefined;
  return redactPII(t).redacted.replace(/\s+/g, " ").slice(0, 120);
}

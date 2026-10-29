// Catatan "pertanyaan interview + jawaban 30 detik" per level /learn — PRESENTER-ONLY
// (visibility-rules.md baris "/learn: pertanyaan interview + jawaban 30 detik" -> ❌ publik).
// SENGAJA ditaruh di src/ (kode server), BUKAN di ui/src/ (kode client) -> tidak pernah masuk
// bundle JS yang dikirim ke browser pengunjung publik (lihat temuan QA: 13 pasang Q&A sebelumnya
// ikut ter-bundle walau disembunyikan di UI, bisa dibaca lewat view-source). Hanya dikirim lewat
// GET /api/presenter/qa yang mewajibkan cookie Presenter (lihat src/index.ts, src/security/presenter.ts).
export interface PresenterQaEntry {
  id: string;
  interviewQ: string;
  interviewA: string;
}

export const PRESENTER_QA: PresenterQaEntry[] = [
  {
    id: "llm-dasar",
    interviewQ: "Bedanya token, prompt, dan context window itu apa, dan kenapa penting buat agentic chat?",
    interviewA:
      "Token = satuan teks terkecil yang diproses model (bukan kata utuh). Prompt = semua teks yang dikirim ke model saat itu (instruksi sistem + riwayat + input user). Context window = batas jumlah token yang bisa 'diingat' model dalam satu panggilan — begitu percakapan makin panjang, bagian lama bisa terpotong, jadi agen harus sadar budget token-nya, apalagi kalau RAG+tools menambah banyak teks ke prompt.",
  },
  {
    id: "chat-app",
    interviewQ: "Kenapa pakai Durable Object + Agents SDK, bukan simpan histori chat di database biasa?",
    interviewA:
      "Durable Object memberi SATU instance terisolasi per percakapan dengan storage lokal + lifecycle otomatis — cocok untuk state percakapan yang perlu konsistensi kuat tanpa race condition antar pesan. Cloudflare Agents SDK (`AIChatAgent`) membungkus itu dan otomatis menambah persistensi pesan + resumable streaming bawaan, jadi tidak perlu kode manual simpan-baca history seperti versi pertama demo ini.",
  },
  {
    id: "rag",
    interviewQ: "Gimana kamu mencegah RAG 'mengarang' jawaban (hallucination) di domain yang sensitif kayak aturan pinjaman?",
    interviewA:
      "Dua lapis: (1) `SCORE_THRESHOLD=0.45` menolak retrieval yang similarity-nya lemah sebelum sampai ke LLM, (2) `checkCitationsGrounded` di guard_out menolak balasan yang sitasinya TIDAK benar-benar ada di hasil retrieval turn itu — jadi groundedness-nya dicek terhadap data nyata yang diambil, bukan cuma larangan di system prompt. Catatan jujur: ini baru memastikan ID sitasi valid, belum memvalidasi klaim teksnya benar-benar didukung isi chunk (itu yang masih di-defer, lihat README §11).",
  },
  {
    id: "tools-agen",
    interviewQ: "Gimana cara kamu memastikan agen tidak bisa 'ditipu' untuk mengakses data orang lain?",
    interviewA:
      "`actor_id` yang dipakai tool SELALU berasal dari sesi yang sudah lolos verifikasi dua faktor (nomor pinjaman/ID pendana + tanggal lahir) di server — tidak pernah dari argumen yang diklaim LLM atau user. Jadi walau prompt injection berhasil bikin LLM 'mau' memanggil tool dengan ID lain, tool itu tetap row-level terbatas ke `ctx.verifiedActorId` yang sudah diverifikasi sebelumnya, bukan ke ID sembarang yang disuruhkan.",
  },
  {
    id: "langgraph",
    interviewQ: "Kenapa migrasi ke LangGraph.js StateGraph, bukan tetap pakai loop agen manual?",
    interviewA:
      "StateGraph bikin alur agen EKSPLISIT dan bisa diinspeksi per node (state Zod, span per node) — gampang dites dan dilacak dibanding satu fungsi loop manual. Yang penting: migrasi ini TIDAK menulis ulang logika guard/router/RAG/tool dari nol — setiap node cuma memanggil ulang fungsi yang sama persis yang sudah lolos eval sebelum migrasi, hanya diorganisasi ulang jadi node graph. Itu sengaja, supaya risiko regresi dari migrasi minimal dan bisa diverifikasi lewat eval yang sama.",
  },
  {
    id: "guardrails-pdp",
    interviewQ: "UU PDP & POJK 40/2024 itu ngaruh ke desain agen gimana, bukan cuma ke kebijakan di atas kertas?",
    interviewA:
      "Konkret: (1) PII di-redaksi jadi token sebelum LLM/Llama Guard/audit log melihatnya apa pun — itu kontrol teknis, bukan janji prompt; (2) keputusan kredit/restrukturisasi TIDAK pernah diputuskan otomatis oleh agen — selalu berhenti di persetujuan CS manusia (four-eyes), sejalan dengan larangan keputusan otomatis Pasal 10 UU PDP; (3) `checkMemberPrivacyLeak` mencegah bocor data antar majelis walau user 'mengaku' satu kelompok.",
  },
  {
    id: "keamanan-agentic",
    interviewQ: "Kalau diminta 'serang sistem kamu sendiri', lapisan mana yang paling mungkin ditembus dan gimana kamu tahu?",
    interviewA:
      "Paling rapuh secara desain: heuristik regex untuk prompt injection (lapisan pertama) — pasti ada pola baru yang lolos karena sifatnya daftar pola, bukan pemahaman makna. Makanya ada Llama Guard sebagai lapis kedua (fail-open ke heuristik kalau errornya), DAN lapisan independen di guard_out (groundedness, privasi antar-majelis) yang tidak bergantung pada lapisan pertama berhasil mendeteksi. Cara tahu: red-team suite diukur ASR-nya (Attack Success Rate), bukan diasumsikan aman — hasil run terakhir 0%, tapi itu angka dari 11 skenario yang sudah diketahui, bukan jaminan untuk pola serangan baru.",
  },
  {
    id: "hitl",
    interviewQ: "Bukannya LangGraph punya interrupt()/Command() bawaan buat human-in-the-loop? Kenapa tidak dipakai itu?",
    interviewA:
      "Jujur: TIDAK — four-eyes restrukturisasi di demo ini jalan lewat status D1 (`pending_cs_approval` → `approved_once` → `submitted`/`rejected`), bukan lewat mekanisme interrupt/resume checkpoint LangGraph native. Efeknya sama (aksi berisiko ditahan sampai CS approve — dan sekarang wajib 2 approver BERBEDA), tapi secara teknis itu gate di lapisan data, bukan state-graph yang sungguhan di-pause lalu di-resume. Ini keterbatasan yang dicatat jujur, bukan diklaim selesai.",
  },
  {
    id: "evaluasi-observability",
    interviewQ: "Kalau eval-nya 45/45, kenapa laporan ini jujur-jujur bilang sekarang cuma 42/45? Bukannya itu kelihatan buruk?",
    interviewA:
      "Karena itu justru bukti observability-nya jalan: regresi 3 kasus itu KETAHUAN lewat eval otomatis + trace Langfuse tepat setelah ganti provider LLM darurat (bukan ditemukan user atau disembunyikan). Analisisnya juga sudah ada: 2 beda gaya jawab, 1 beda hasil vektor embedding — bukan bug logika atau regresi keamanan. Melaporkan angka turun DENGAN akar masalahnya itu yang menurut saya lebih kredibel daripada klaim '45/45 terus' tanpa bisa jelaskan kenapa providernya diganti.",
  },
  {
    id: "optimasi",
    interviewQ: "Gimana strategi kamu nurunin biaya per percakapan di sistem seperti ini kalau trafiknya naik 100x?",
    interviewA:
      "Saat ini belum diimplementasikan, saya jujur soal itu — tapi arahnya jelas dari yang sudah ada: (1) semantic cache untuk pertanyaan FAQ-ish yang sering berulang (banyak pertanyaan 'kapan jadwal majelis' dkk sangat repetitif), (2) model routing/cascade — pakai model kecil/murah dulu untuk intent sederhana, baru eskalasi ke model besar kalau perlu reasoning, (3) AI Gateway penuh untuk fallback+caching+rate-limit terpusat (sekarang fallback Kenari↔Workers AI masih manual lewat kode, belum lewat Gateway). Yang sudah terukur nyata: pindah ke provider cadangan Kenari nambah ~2x first-token latency (hop jaringan eksternal) — itu baseline yang mau diperbaiki semantic cache & routing nanti.",
  },
  {
    id: "inklusi",
    interviewQ: "Kenapa tidak langsung bangun fitur voice note/bahasa daerah kalau konteksnya mitra lembaga keuangan mikro yang literasi digitalnya beragam?",
    interviewA:
      "Trade-off waktu vs nilai tambah yang jujur: guardrail yang ada SUDAH toleran bahasa informal/typo/daerah secara umum (16 kasus eval `informal_*` lolos), jadi WOW incremental dari membangun fitur Whisper/bahasa-daerah dedicated dalam semalam lebih rendah dibanding effort-nya — risikonya malah menambah bug di fitur baru yang belum diuji. Untuk produksi beneran, voice note (Whisper) dan deteksi bahasa daerah eksplisit tetap masuk roadmap (lihat level 10), cuma didahulukan yang paling murah-effort-tinggi-nilai dulu.",
  },
  {
    id: "produksi-skala",
    interviewQ: "Kalau ini harus dipakai beneran oleh lembaga keuangan mikro untuk ribuan mitra, apa 3 hal pertama yang kamu benerin dari demo ini?",
    interviewA:
      "(1) Auth Konsol CS — sekarang shared-secret token demo, produksi butuh SSO/RBAC per petugas; (2) AI Gateway penuh untuk observability+rate-limit+caching terpusat, bukan rate-limit D1 custom per-IP; (3) kanal WhatsApp Business API dengan rollout bertahap (mulai dari 1 majelis/cabang) ditambah dashboard monitoring real (anomaly rate, guard-block rate) dan runbook insiden yang benar-benar dilatih tim, bukan cuma dokumen. Semua ini saya tandai USULAN di README, bukan klaim sudah jalan — supaya jelas mana yang demo-ready dan mana yang production-ready.",
  },
  {
    id: "penutup",
    interviewQ: "",
    interviewA:
      "Ringkasan 30 detik: demo ini LangGraph.js StateGraph di atas Cloudflare Agents SDK — guard_in (PII+injeksi) → verify_identity → route_intent (+ HITL four-eyes) → tools (RAG+ReAct, least-privilege) → guard_out (sitasi+privasi antar-majelis) → respond. Semua diukur: 42/45 eval, 0/11 red-team, trace per node di Langfuse. Bagian yang masih diusulkan (voice note, semantic cache, WhatsApp scale) ditandai jujur, bukan diklaim selesai.",
  },
];

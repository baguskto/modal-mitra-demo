# Catatan untuk halaman /learn — fitur tambahan (feat/extras)

Bukan scope worker ini untuk membangun UI `/learn` (lihat `projects/interview-prep/plan-agents-sdk-langgraph-langfuse.md`
dan `task-learn-page.md` — halaman itu dibangun worker lain). Dokumen ini hanya **bahan siap pakai**
(analogi, WOW fact angka nyata, pertanyaan interview 30 detik) untuk level yang relevan, supaya
worker `/learn` tidak perlu riset ulang isi fitur-fitur ini.

---

## Level 9 — Inklusi: Voice note (Whisper STT/TTS)

- **Analogi 1 kalimat**: "seperti kirim voice note WhatsApp ke CS, tapi yang 'dengar' robotnya duluan lalu diketik otomatis."
- **Lihat di demo**: kirim voice note di Live Chat → X-Ray menyorot event `stt` (durasi transkripsi, jumlah kata) sebelum masuk ke alur chat normal.
- **Pertanyaan interview (30s)**: "Kenapa STT bukan TTS yang jadi prioritas untuk literasi digital rendah?" → Jawab: input suara menghilangkan barrier mengetik (lebih besar dampaknya di pedesaan daripada mendengar balasan, yang bisa dibaca anggota keluarga/anak); TTS tetap disediakan opsional dengan fallback Web Speech API browser karena belum ada model TTS Workers AI yang terverifikasi bagus untuk Bahasa Indonesia — jujur didokumentasikan, bukan diklaim beres.
- **WOW fact**: toggle `FEATURE_VOICE`, 8 unit test lulus, model `@cf/openai/whisper-large-v3-turbo` (Workers AI free tier, Rp0 biaya tambahan).

## Level 9 — Inklusi: Deteksi bahasa (Jawa/Sunda ringan + Indonesia informal)

- **Analogi 1 kalimat**: "robotnya ikut 'logat' lawan bicara — kalau pengguna nyampur Jawa/Sunda, balasannya ikut lebih hangat, bukan kaku Bahasa Indonesia baku."
- **Lihat di demo**: ketik kalimat campur Jawa/Sunda → X-Ray `lang_detect` menunjukkan bahasa terdeteksi + confidence, lalu gaya balasan berubah (istilah keuangan/regulasi TETAP Bahasa Indonesia baku, demi akurasi).
- **Pertanyaan interview (30s)**: "Kenapa deteksi bahasa pakai leksikon/regex, bukan model klasifikasi?" → Jawab: korpus campur-kode Jawa/Sunda-Indonesia informal terlalu kecil & beragam ejaannya untuk model statistik umum; leksikon kata-partikel khas (presisi tinggi) konsisten dengan gaya `classifyIntent` yang sudah ada di repo ini (deterministik, murah, 0 latensi tambahan, tidak perlu panggilan LLM lagi per giliran).
- **WOW fact**: 10/10 kalimat uji lulus (`npm run eval:extras`), 0ms panggilan network untuk deteksi.

## Level 8 — Optimasi: semantic cache + model routing/cascade + AI Gateway

- **Analogi 1 kalimat**: "seperti customer service senior yang melempar pertanyaan mudah ke staf baru (murah/cepat) dan baru naik ke manajer (mahal) kalau memang rumit — dan kalau ada pertanyaan yang SAMA PERSIS maknanya baru ditanyakan lagi, tinggal baca catatan lama."
- **Lihat di demo**: tanya pertanyaan FAQ sederhana → X-Ray `route` menunjukkan tier termurah (`deepseek-v4-1-flash`) yang menjawab; tanya lagi pertanyaan serupa (beda kata) → `cache_hit` (bila semantic cache diaktifkan).
- **Pertanyaan interview (30s)**: "Kenapa threshold semantic cache diset 0,92 (tinggi), bukan 0,8?" → Jawab: cache hit yang salah (jawaban keliru tersaji ke pengguna) jauh lebih mahal reputasinya daripada cache miss (paling buruk cuma kembali ke jalur normal) — threshold tinggi sengaja mengorbankan recall demi precision, konsisten dengan prinsip "assertion deterministik, bukan LLM-as-judge" yang sudah dipakai di eval utama.
- **WOW fact**: provider LLM Kenari (OpenAI-compatible) diukur langsung — tier termurah `deepseek-v4-1-flash` ~2,8s, TIDAK lebih lambat dari Workers AI qwen3 (4,4s p50 end-to-end); allowlist kode menolak model mahal (`gpt-6-astra`, ~10× lebih mahal) sebelum request terkirim.

## Level 6 — Human-in-the-loop: Cloudflare Workflows untuk SLA/eskalasi

- **Analogi 1 kalimat**: "seperti alarm dapur — dipasang begitu makanan masuk oven, tetap berbunyi walau yang masak sudah pindah ruangan atau komputernya restart."
- **Lihat di demo**: handoff ke CS tanpa CS merespons → setelah 5 menit, X-Ray menyalakan `sla_escalated`, muncul di panel eskalasi (`GET /api/extras/sla/escalations`).
- **Pertanyaan interview (30s)**: "Kenapa harus Cloudflare Workflows, bukan `setTimeout`/`alarm` Durable Object biasa?" → Jawab: Workflows adalah primitif durable BAWAAN (checkpoint tiap `step`, retry otomatis, survive restart/deploy Worker) — cocok untuk timer yang HARUS menyala walau Worker/DO yang memulainya sudah tidak hidup lagi; `setTimeout` di Worker hilang begitu instance berhenti.
- **WOW fact**: keputusan eskalasi (`decideEscalation`) dipisah murni dari runtime Workflow sehingga 100% dites di Node tanpa `wrangler dev` — 10 unit test + 3 eval case, 0 biaya tambahan (dalam limit free tier Workflows).

## Level 5 — Guardrails & UU PDP: memori jangka panjang dengan persetujuan + hak hapus

- **Analogi 1 kalimat**: "seperti barista hafal 'kopi susu, kurang gula' kalau kita izinkan — dan begitu kita bilang berhenti, catatannya langsung disobek, bukan cuma dicoret."
- **Lihat di demo**: aktifkan toggle memori untuk satu mitra demo → tanya hal yang sama 2 sesi berbeda → X-Ray `memory_read` menunjukkan ringkasan terpakai; tarik persetujuan → `memory_deleted`, baris sungguhan terhapus di D1.
- **Pertanyaan interview (30s)**: "Kenapa consent dicek ulang di setiap operasi tulis, bukan cuma sekali di awal?" → Jawab: persetujuan bisa ditarik kapan saja (hak subjek data, UU PDP); mengecek sekali di awal lalu mempercayainya selamanya berarti bisa menulis data baru SETELAH pengguna menarik persetujuan tanpa sadar — re-check di setiap operasi adalah pagar yang benar secara desain, bukan optimisasi prematur.
- **WOW fact**: satu bug nyata ditemukan sendiri saat menulis unit test (SQL UPSERT yang mencampur literal inline dengan placeholder `?` membuat argumen `bind()` salah urut pada path "tarik persetujuan") — dicatat apa adanya di README §11.5, bukan disembunyikan; diperbaiki sebelum commit.

<!-- Entri berikutnya (Langfuse prompt mgmt/online eval) ditambahkan di sini begitu fitur terkait
     selesai — lihat commit feat/extras berikutnya. -->

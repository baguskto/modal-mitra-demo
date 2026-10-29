# Modal Mitra Contoh — Demo Agentic Live Chat (P2P Micro-Lending)

> **Demo interview Senior AI Engineer.** Perusahaan **"Modal Mitra Contoh" FIKTIF**, gaya P2P micro-lending/LPBBTI berbasis kelompok (mirip model bisnis yang dipakai di sektor ini secara umum), **seluruh data 100% sintetis**. Dibangun dengan AI-assisted engineering (agent coding) sebagai demonstrasi arsitektur & cara berpikir, bukan klaim "sudah produksi". Bukan afiliasi, tidak memakai merek/logo pihak manapun.
>
> **Live demo:** https://modal-mitra-demo.markas-auracheck.workers.dev
> Tab **"Live Chat"** (pilih persona Mitra/Pendana), **"Konsol CS"** (butuh token demo, tersimpan lokal di `.cs-token.local` project ini — lihat §7 poin K1), **"Dashboard"**.
>
> **Basis:** diadaptasi dari demo `sigap-nasabah` (agen layanan nasabah multifinance, live di `sigap-nasabah-demo.markas-auracheck.workers.dev`), ditulis ulang untuk domain P2P micro-lending + live chat real-time.

---

## 1. Apa ini

Demo **agentic live chat** untuk P2P micro-lending berbasis kelompok (majelis/tanggung renteng, gaya Grameen): streaming token real-time via WebSocket + Durable Object, indikator mengetik, sesi multi-pengguna, antrean & handoff ke CS manusia dengan SLA timer dan ringkasan otomatis, dua persona (mitra/peminjam & pendana/lender) dengan guardrail khusus LPBBTI & UU PDP, RAG bersitasi, tool-calling terverifikasi, audit log hash-chain, dan eval golden set yang diperluas untuk bahasa informal/daerah + injeksi + kebocoran data antar-majelis.

---

## 2. Arsitektur

```
┌─────────────────────┐        ┌──────────────────────────┐
│ Live Chat (React)    │        │ Konsol CS (React)          │
│ persona mitra/pendana│        │ antrean+SLA, takeover live  │
│ gaya WhatsApp mobile  │        │ ringkasan handoff           │
└──────────┬───────────┘        └──────────┬────────────────┘
           │ WebSocket /api/chat/:id/ws     │ WebSocket /api/cs/:id/ws (token demo)
           ▼                                 ▼
┌────────────────────────── Cloudflare Worker (Hono, TypeScript) ──────────────────────────┐
│                                                                                            │
│  Durable Object "ChatSession" (1 instance per sessionId, WebSocket Hibernation API)       │
│   state: persona, mode (AI|HUMAN), verifiedActorId, history, handoffSummary, handoffAt    │
│   broadcast real-time ke semua socket tersambung (pengguna multi-tab + observer CS)       │
│                                                                                            │
│  runAgentTurn() — src/agent/toolAgent.ts:                                                 │
│   1. GUARD input: heuristik injeksi → redaksi PII (termasuk tanggal lahir, token di vault  │
│      per-giliran) → Llama Guard (teks teredaksi) → scope                                  │
│   2. ROUTER: intent (info|akun|pengajuan|keterlambatan|pengaduan|hak_data|lain) + persona  │
│   3. AKSI DETERMINISTIK (bukan tergantung kepatuhan LLM): pengaduan → tiket SLA (termasuk  │
│      yang memicu handoff — lihat K5 di §6); hak_data → DSR; keterlambatan → restrukturisasi│
│   4. RAG: embed (BGE-M3) → Vectorize topK=8, skor ≥0,45 → <data>, "/no_think" per giliran  │
│   5. Agent loop ≤6 langkah: JSON tool_call | final_answer, Zod + alias field               │
│   6. GUARD output: PII scan, larangan janji finansial, sitasi wajib+grounded, privasi      │
│      antar-majelis (checkMemberPrivacyLeak — ID pinjaman/pendana lain tidak boleh disebut) │
│   7. Relay teks (SUDAH lolos guard) ke klien per kata via WebSocket -> terlihat "mengalir"  │
│   8. Audit D1 hash-chain per sesi                                                          │
│                                                                                            │
│  D1 (majelis, mitra, pinjaman, angsuran, pendana, pendanaan, tickets, dsr_requests,       │
│      restructuring_requests, audit_log, sessions_index) · Vectorize 1024-dim cosine        │
│  Model: Qwen3-30B-A3B fp8 (MoE) → fallback Llama 3.1 8B · React SPA                        │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Fitur live chat (prioritas #1 di brief)

- **Streaming real-time** via WebSocket (Durable Object Hibernation API): token "mengalir" ke UI, bukan tunggu respons penuh. **Catatan jujur soal implementasi** — lihat §6 Keputusan Desain poin "Streaming non-token-mentah": Workers AI `stream:true` untuk model `@cf/qwen/qwen3-30b-a3b-fp8` TERBUKTI merusak karakter kutip JSON saat streaming (diverifikasi langsung, lihat bukti di §6), jadi panggilan LLM-nya sendiri non-streaming (demi keandalan tool-calling & guardrail), lalu teks yang **sudah lolos guard** direlai ke klien per-kata lewat WebSocket — pengalaman "mengetik real-time" tetap didapat, transportnya genuinely real-time, hanya sumber token bukan streaming mentah dari model.
- **Indikator mengetik** dua arah: AI (`ai_typing_start/end`) dan CS manusia (`typing` event, relay antar role).
- **Sesi multi-pengguna**: semua WebSocket yang tersambung ke sessionId yang sama (tab lain pengguna + konsol CS yang observe) menerima broadcast pesan secara real-time, bukan hanya optimistic update lokal pengirim.
- **Antrean & handoff real-time**: `GET /api/cs/queue` (butuh token CS) — sesi mode HUMAN diurutkan dari yang menunggu paling lama, dengan **SLA timer 5 menit** (badge hijau/kuning/merah di Konsol CS) dan **ringkasan otomatis** (LLM kecil meringkas transkrip 1-2 kalimat untuk CS yang akan mengambil alih).
- **Takeover/release live**: CS klik takeover → AI berhenti menjawab sesi itu, balasan CS tersiar langsung ke pengguna; release → kembali ke AI. Keduanya mengubah state DO secara atomik (bukan via tool LLM yang bisa "berbohong" — lihat K5 §6).

---

## 4. Persona & guardrail LPBBTI/UU PDP

| Persona | Kebutuhan | Guardrail khusus |
|---|---|---|
| **Mitra** (peminjam, anggota majelis) | Jadwal/sisa angsuran mingguan, jadwal pertemuan majelis, pengajuan/top-up, keterlambatan & restrukturisasi, pengaduan | Tidak pernah menjanjikan persetujuan pinjaman/plafon/restrukturisasi (selaras **Pasal 10 UU PDP** — larangan keputusan otomatis berdampak signifikan); bahasa penagihan selalu menenangkan & solutif |
| **Pendana** (lender) | Portofolio, status pencairan, risiko | Disclaimer risiko wajib setiap bahas pendanaan baru/imbal hasil (bukan simpanan, bukan dijamin LPS); tidak pernah merekomendasikan "danai X" atau menjamin imbal hasil |
| **Petugas lapangan** *(opsional, prioritas rendah)* | Copilot internal | Arsitektur persona sudah ada di router/prompts, **tool & UI khusus belum dibangun** — lihat §7 |

**Guardrail privasi antar-majelis** (kebutuhan spesifik model bisnis kelompok/tanggung renteng): `checkMemberPrivacyLeak()` (`src/guards/output.ts`) memastikan jawaban final tidak pernah menyebut nomor pinjaman/ID pendana LAIN selain milik actor yang terverifikasi di sesi ini DAN benar-benar diambil oleh tool call turn tersebut (groundedness, bukan sekadar larangan di prompt). Diuji di `evals/promptfooconfig.yaml` (`adv_09_group_data_leak_attempt`).

**Verifikasi identitas sebelum data pribadi**: dua faktor (nomor pinjaman/ID pendana + tanggal lahir), `actor_id` operasi SELALU dari state sesi terverifikasi, tidak pernah dari klaim/argumen LLM (least-privilege, lihat `src/tools/execute.ts`).

---

## 5. Eval

`evals/promptfooconfig.yaml` — 45 kasus: 7 RAG+sitasi, 8 tool-calling (mitra & pendana), 4 HITL, 10 adversarial (injeksi langsung/tidak langsung, scope, PII, janji terlarang, **kebocoran data antar-majelis**), dan **16 kasus bahasa informal** (typo, singkatan, campur bahasa daerah Sunda/Jawa/Betawi ringan — melebihi target ≥15).

Jalankan: `npm run eval` (default menembak `https://modal-mitra-demo.markas-auracheck.workers.dev`, override dengan `MMK_BASE_URL`).

**Hasil run terakhir: 45/45 lulus** (lihat `evals/results.json`, timestamp run tercatat di file). Satu kasus (`informal_14_abbrev_minta_cs`, "mnt tlg sambungin ke cs dong pls") GAGAL pada run pertama karena regex permintaan CS eksplisit belum menangkap singkatan "sambungin"/"mnt" — diperbaiki (`src/agent/toolAgent.ts`, pola `explicitHumanRequest` diperluas), lalu lulus di run kedua. Dicatat apa adanya, bukan dihapus dari riwayat.

**Catatan tooling eval:** CLI `promptfoo` (v0.100.6) di environment ini mengalami `SQLiteError: FOREIGN KEY constraint failed` pada SETIAP run (termasuk config paling trivial sekalipun) — bug kombinasi versi `promptfoo`+`better-sqlite3` di environment ini, bukan terkait golden set. `evals/promptfooconfig.yaml` tetap dipakai sebagai sumber kebenaran test case (format tetap kompatibel promptfoo untuk portabilitas), tapi dieksekusi lewat `scripts/run-eval.ts` — runner mandiri yang mem-parse YAML yang sama dan mengevaluasi assertion (`icontains`/`not-contains`/`not-regex`/`javascript`) langsung tanpa database hasil promptfoo. `npm run eval` sudah diarahkan ke runner ini.

**Latensi** (`npm run latency`, 6 skenario representatif × 3 repetisi, lihat `evals/latency-results.json`):

| Metrik | p50 | p95 |
|---|---|---|
| first-token (lihat definisi di §6) | 1.981 s | 15.756 s |
| total | 4.405 s | 18.492 s |

Sebaran per-skenario: RAG sederhana ~2-3s, verify+lookup mitra ~4-8s, jadwal majelis ~3-4s, **verify+portofolio pendana paling lambat (6-18s)** karena 2 tool call berurutan (verify_pendana → get_portofolio) sebelum generasi jawaban akhir — kandidat optimisasi pertama untuk produksi (lihat §8 observability: router/model kecil untuk alur lookup). Guard block (scope) & handoff eksplisit umumnya <1s, dengan 2 outlier (7,2s dan 6s) yang konsisten dengan cold-start Llama Guard/D1 pertama kali dipanggil dalam sesi baru.

**Temuan nyata dari eval (jangan disembunyikan saat interview):** Llama Guard (lapisan kedua guard injeksi) menunjukkan **false-positive ~30-50%** untuk pesan yang mencampur bahasa distress informal ("aduh maap...") dengan data verifikasi pribadi (nomor pinjaman+tanggal lahir) — diuji manual 3× berulang pada kasus yang identik, hasil tidak konsisten. Ini bukan bug kode, melainkan karakteristik model classifier safety yang probabilistik; mitigasinya di eval ini adalah menerima handoff-ke-CS sebagai outcome yang SAMA VALIDNYA dengan jawaban sukses (lihat assertion `tool_08`), bukan memaksakan satu jalur. Di produksi, false-positive rate seperti ini butuh dashboard monitoring tersendiri (lihat §8 observability).

---

## 6. Keputusan Desain (termasuk trade-off yang disengaja)

| Keputusan | Alasan / trade-off |
|---|---|
| **Streaming = relay pasca-guard, bukan token mentah model** | Dibuktikan langsung (endpoint debug sementara, dihapus sebelum selesai): Workers AI `stream:true` untuk `@cf/qwen/qwen3-30b-a3b-fp8` konsisten merusak karakter kutip JSON (`{"type:final_answer,text:...` — kutip hilang tepat di sekitar key/value awal), sementara non-streaming SELALU valid untuk prompt yang identik (diuji berulang). Kemungkinan bug detokenizer streaming Workers AI untuk model ini. Memilih keandalan tool-calling/guardrail (non-streaming) + relay per-kata ke klien (jeda 18ms/kata) demi UX "mengalir" yang tetap real-time secara transport (WebSocket), bukan demi klaim "token mentah dari model" yang di model ini justru tidak reliable. |
| **`/no_think` di setiap giliran** | Qwen3 adalah model reasoning; mode thinking defaultnya menghabiskan ratusan token sebelum menjawab (terbukti 203 event SSE vs 24 event dengan `/no_think` untuk prompt yang sama) tanpa manfaat untuk tugas tool-calling/jawaban singkat ini → latensi jauh lebih rendah, tanpa kehilangan kualitas jawaban yang teramati. |
| **MAX_STEPS = 6** (sebelumnya 3 di basis) | Basis (`sigap-nasabah`) terbukti gagal 3/5 pada alur verify→lookup→final karena limit 3 langkah pas-pasan untuk 3 panggilan LLM. Dinaikkan dengan margin; alur verify+get_angsuran+final & verify+get_majelis_info+final diuji berulang kali sukses di demo ini (lihat §7 perbaikan K4). |
| **Idempotensi tool kepatuhan dalam 1 giliran** | `create_complaint_ticket`/`create_dsr_request`/`create_restructuring_request` dibuat DETERMINISTIK oleh kode begitu intent terdeteksi; jika LLM JUGA mencoba memanggil tool yang sama di langkah agen, hasil yang SUDAH ada dikembalikan (bukan duplikat) — ditemukan sendiri saat uji manual (DSR tercatat 2×), diperbaiki di `toolAgent.ts`. |
| Aksi kepatuhan & privasi deterministik, LLM hanya merangkai kalimat | Tiket/DSR/restrukturisasi/batas akses data tidak pernah bergantung pada LLM "mau" memanggil tool yang benar — konsisten dengan pola Toco Chat AI (produksi). |
| `actor_id` dari sesi, bukan dari LLM | Least-privilege: walau prompt injection lolos regex/Llama Guard, tidak ada tool yang bisa membaca data milik pihak lain. |
| JSON kustom (bukan native function calling) | Portabel antar model Workers AI; trade-off: parser kurung-kurawal buatan sendiri, tanpa constrained decoding native. |
| Assertion deterministik di eval, bukan LLM-as-judge | Murah, stabil, mudah didebug; tidak mengukur faithfulness granular (lihat §7, belum diperbaiki). |
| OpenRouter TIDAK dipakai | Hemat kuota $5 milik project lain sesuai instruksi; semua inferensi lewat Workers AI (free tier demo). |

---

## 7. Temuan & perbaikan dari review mock-interview (sebelum fitur live chat ditambahkan)

Sebelum membangun fitur live chat, sebuah mock-interview review (`projects/interview-prep/mock-interview.md`, dilakukan terhadap basis `sigap-nasabah`) menemukan beberapa bug nyata. Berikut status masing-masing **di demo live-chat ini**:

1. **Tidak ada memori percakapan multi-turn** — **Ditangani berbeda dari saran awal, bukan diabaikan**: `verifiedActorId` persisten di state Durable Object per sesi (bukan di-reset tiap giliran), jadi pertanyaan lanjutan ("berapa total yang masih harus saya bayar?" setelah verifikasi) **terbukti berhasil tanpa verifikasi ulang** (diuji langsung, 2 giliran berurutan). Sengaja **tidak** menyuntikkan riwayat mentah ke prompt tiap giliran — itu akan mengirim ulang PII riwayat (termasuk tanggal lahir) ke LLM setiap kali, kebocoran baru yang justru bertentangan dengan perbaikan #6. Trade-off ini didokumentasikan, bukan disembunyikan.
2. **MAX_STEPS=3 terlalu kecil, alur "cek cicilan" harus sukses 5/5** — **Diperbaiki**: dinaikkan ke 6 (`src/agent/toolAgent.ts`), diuji ulang manual untuk alur verify+lookup dan verify+majelis — sukses di setiap percobaan manual yang dilakukan.
3. **Pengaduan ancaman/penagihan kasar harus membuat tiket + handoff, bukan hanya alih ke CS** — **Diperbaiki**: urutan dibalik — pembuatan tiket (`create_complaint_ticket`, severity mengikuti severity HITL) sekarang berjalan SEBELUM early-return handoff, dan nomor tiket disertakan di kalimat handoff ke pengguna (`src/agent/toolAgent.ts`).
4. **Tool `handoff_to_human` yang dipanggil LLM tidak benar-benar mengubah mode sesi** — **Diperbaiki**: saat LLM memanggil tool ini, loop agen langsung mengembalikan `handoff.triggered=true` (bukan lanjut ke `final_answer` seolah tidak terjadi apa-apa) — ChatSession.ts lalu benar-benar mengubah `mode` ke HUMAN berdasarkan field ini.
5. **Endpoint Konsol CS/history/audit tanpa autentikasi** — **Diperbaiki (sebagian, demo-grade)**: ditambah shared-secret token (`CS_TOKEN`, header `x-cs-token` untuk REST / query `?token=` untuk WebSocket — browser tidak bisa kirim header kustom saat handshake WS) di `requireCsToken` middleware (`src/index.ts`), diterapkan ke `/api/cs/*`, `/api/audit/*`, `/api/chat/:id/history`. **Ini BUKAN auth produksi** (tidak ada SSO/RBAC/per-user audit) — jujur disebutkan sebagai batas demo, bukan diklaim selesai.
6. **Tanggal lahir (faktor verifikasi ke-2) tidak diredaksi sebelum masuk LLM/audit log** — **Diperbaiki**: pola `TANGGAL` (`\d{4}-\d{2}-\d{2}`) ditambahkan ke `src/guards/pii.ts`, mengikuti mekanisme vault/token yang sama dengan nomor pinjaman/ID pendana.
7. (Tambahan, ditemukan sendiri saat verifikasi fix #3/#4) **`emptyBlockedResult` mereset `verifiedActorId` ke null setiap kali guard memblokir pesan** — **Diperbaiki**: sekarang mempertahankan status verifikasi yang sudah ada; satu pesan yang kena false-positive guard tidak lagi memaksa verifikasi ulang dari awal.

**Regulasi**: POJK 10/POJK.05/2022 (dasar P2P lending lama) sudah **dicabut** oleh **POJK 40/2024** tentang LPBBTI (berlaku 27 Des 2024) — dipakai sebagai rujukan di KB (`data/synthetic/kb/ringkasan-pojk40-2024-lpbbti.md`), bukan POJK 10/2022 atau POJK 22/2023 (Pelindungan Konsumen — regulasi terpisah, tetap relevan untuk SLA pengaduan, tetap dirujuk untuk itu saja).

**Yang BELUM diperbaiki (jujur, bukan diklaim selesai)**: race condition DO lintas `await` eksternal (K8 di dokumen review — belum direproduksi dengan tes konkuren di demo ini); faithfulness sitasi (groundedness saat ini hanya memastikan ID sitasi ADA di hasil retrieval, belum memastikan klaimnya didukung chunk tersebut); HMAC/anchoring WORM untuk audit log (hash saat ini tanpa kunci rahasia, bisa dihitung ulang oleh siapa pun berakses tulis D1).

---

## 8. Pemetaan ke kebutuhan Amartha (arsitektur produksi — USULAN, bukan klaim)

> Riset singkat fakta publik (29 Okt 2026), dicatat dengan sumber — **bukan klaim internal Amartha**, angka statistik dari materi marketing mereka sengaja tidak dikutip sebagai fakta operasional:
> - OJK-licensed sejak 2019, terdaftar AFPI, kini diatur **POJK 40/2024 (LPBBTI)** — [ojk.go.id](https://ojk.go.id/id/regulasi/Pages/POJK-40-Tahun-2024-Layanan-Pendanaan-Bersama-Berbasis-Teknologi-Informasi.aspx)
> - Model group-lending ala Grameen: kelompok kecil 5 orang → majelis 15-20 orang — [amartha.com/blog](https://amartha.com/blog/bisnis-umkm/p2p-lending-alternatif-pinjaman-modal-usaha-yang-aman-dan-mudah)
> - CS existing: **Amartha Care**, call center + WhatsApp, 06.00-21.00 WIB — [amartha.com/amartha-care](https://amartha.com/amartha-care)

| Kebutuhan produksi | Komponen demo ini yang relevan | Yang HARUS diubah/ditambah untuk produksi |
|---|---|---|
| **Gateway WhatsApp Business API** (channel utama sesuai CS existing) | Protokol WS/JSON sudah terpisah bersih dari transport (DO ChatSession tidak tahu "WhatsApp" vs "web") | Webhook WA Business Platform (atau penyedia BSP seperti Qiscus/Moceanapi) → Worker → DO per nomor telepon; **dedupe `message.id`** (webhook di-retry); jendela 24 jam gratis vs template berbayar di luar jendela; opt-in explicit |
| **Skala ribuan percakapan bersamaan** (jam setelah pertemuan majelis) | 1 DO per sesi = isolasi + skala horizontal alami | Queue (Cloudflare Queues) untuk webhook masuk (balas 200 cepat, proses async); rate limit per provider AI; circuit breaker ke core lending |
| **Biaya per percakapan** | Demo: Rp0 (free tier Workers AI) — **bukan basis produksi** | Estimasi kasar: (token in+out × giliran rata-rata × harga model) + embedding + Llama Guard + biaya pesan WA per kategori template. Perlu dihitung ulang dengan volume riil; model kecil untuk router/guard menurunkan biaya signifikan |
| **Observability** | Audit log hash-chain per sesi (akuntabilitas, BUKAN tracing) | Tracing per-span (guard→retrieve→llm→tool→critic) via Langfuse/AI Gateway (self-host untuk data sensitif), dashboard false-positive rate guard (lihat temuan Llama Guard §5), alert fallback-model rate & SLA tiket terlewat |
| **Rollout bertahap** | — | Discovery dari log CS/Amartha Care nyata (anonim) → PoC golden set dari log asli → shadow mode (AI menyarankan, Business Partner/CS kirim) → pilot 5-10% trafik dengan HITL penuh untuk aksi finansial → rollout bertahap dengan gate eval di tiap tahap |
| **Business Partner (field officer) copilot** | Persona `petugas` sudah ada di router/prompts (`src/agent/router.ts`, `prompts.ts`) | Tool & UI khusus belum dibangun di demo ini (prioritas rendah sesuai brief) — akses berbasis wilayah/majelis yang dipegang, mode offline/ringan untuk sinyal lemah di desa |
| **Verifikasi identitas lebih kuat** | Demo: nomor pinjaman/ID pendana + tanggal lahir (knowledge-based, mudah ditebak) | Produksi: OTP ke nomor WA terdaftar atau login aplikasi resmi + lockout setelah percobaan gagal |

---

## 9. Yang sengaja tidak dikerjakan (prioritas rendah/di luar ±4-5 jam)

- Petugas lapangan copilot: arsitektur persona ada, tool & UI khusus belum.
- Faithfulness/NLI judge untuk groundedness sitasi (hanya ID sitasi yang divalidasi, bukan klaimnya).
- HMAC + anchoring WORM untuk audit log (masih hash tanpa kunci rahasia).
- Rate limiting / lockout verifikasi identitas.
- Voice note (STT/TTS) — relevan untuk literasi digital rendah di pedesaan, di luar scope demo web ini.
- Auth CS produksi (SSO/RBAC per-role) — demo pakai shared-secret token saja.

---

## 10. Jalankan sendiri

```bash
npm install
npx tsx scripts/gen-data.ts        # generate data sintetis -> data/synthetic/*.json + seed.sql
npx tsx scripts/chunk-kb.ts         # chunk dokumen KB -> data/synthetic/kb-chunks.json
npx wrangler d1 create modal_mitra_db        # catat database_id ke wrangler.toml
npx wrangler vectorize create modal-mitra-kb --dimensions=1024 --metric=cosine
npx wrangler d1 execute modal_mitra_db --remote --file=src/db/schema.sql
npx wrangler d1 execute modal_mitra_db --remote --file=data/synthetic/seed.sql
npx wrangler secret put ADMIN_KEY     # untuk endpoint ingest
npx wrangler secret put CS_TOKEN      # untuk Konsol CS/audit/history
npm run deploy                         # build UI + wrangler deploy
npx tsx scripts/run-ingest.ts https://<url-worker-anda>.workers.dev <ADMIN_KEY>
npm run eval                           # MMK_BASE_URL=<url> npm run eval untuk target lain
npm run latency
```

**Identitas demo untuk skenario live** (lihat log `gen-data.ts`):
- Mitra: `MIT-0001` (pinjaman `MMK-100001`, lahir `1985-03-12`, Sri Wahyuni), `MIT-0002` (`MMK-100002`, `1990-07-20`, Yanti Kusuma)
- Pendana: `PND-0001` (lahir `1992-01-15`, Andi Pratama), `PND-0002` (`1988-09-09`, Budi Hartono)

**Catatan memori laptop**: hanya jalankan satu proses dev server sesuai aturan laptop 18GB; untuk demo, cukup pakai URL yang sudah dideploy.

---

## 11. Fitur tambahan (`feat/extras`, dikerjakan paralel di worktree terpisah)

> Dikerjakan di branch `feat/extras` (worktree sendiri) selagi worker inti membangun
> AIChatAgent/LangGraph/Langfuse (v2) di branch utama, sebagai modul **mandiri** (`src/extras/**`)
> dengan antarmuka jelas supaya digabung tanpa konflik besar: worker inti hanya perlu
> `app.route("/api/extras", extrasApp)` di `src/index.ts`/graph node yang sesuai, tanpa extras
> menyentuh state ChatAgent/Durable Object. Tiap fitur punya toggle (lihat `src/extras/config.ts`),
> unit test (`npm run test:extras`), dan entri eval (`npm run eval:extras` / `evals/extras-eval.yaml`).
> Bahan untuk halaman `/learn` (level 8 & 9) ada di `docs/extras-learn-notes.md`.

### 11.1 Voice note (STT/TTS) — toggle `FEATURE_VOICE`
`src/extras/voice/{stt,tts,routes}.ts` + `ui/src/extras/VoiceRecorder.tsx`. Rekam di UI
(`MediaRecorder`) → `POST /api/extras/voice/transcribe` → Whisper Workers AI
(`@cf/openai/whisper-large-v3-turbo`) → teks masuk alur chat seperti pesan biasa (redaksi PII tetap
berlaku di guard input seperti biasa, di luar modul ini). Balasan suara opsional
(`POST /api/extras/voice/speak`) mencoba model TTS Workers AI yang dikonfigurasi (`TTS_MODEL`); bila
gagal/tidak tersedia untuk Bahasa Indonesia (belum ada model TTS Workers AI yang terverifikasi bagus
untuk id — dicatat jujur, bukan ditebak), degradasi otomatis ke **Web Speech API** browser
(`speechSynthesis`, `lang="id-ID"`) di sisi klien. Event X-Ray: `stt`, `tts`.

### 11.2 Deteksi bahasa & gaya balasan — toggle `FEATURE_LANG_DETECT`
`src/extras/language/{detect,style,index}.ts`. Heuristik leksikon/regex (bukan model klasifikasi —
lihat `docs/extras-learn-notes.md` untuk alasannya) untuk Indonesia formal/informal, Jawa ringan,
Sunda ringan. `detectAndStyle(text)` mengembalikan instruksi gaya untuk ditempel ke system prompt
(`buildSystemPrompt`) + event X-Ray `lang_detect`. Istilah keuangan/regulasi/angka TETAP Bahasa
Indonesia baku di semua gaya (akurasi > lokalitas). Diuji 10 kalimat (`evals/extras-eval.yaml`,
`npm run eval:extras`), 0 panggilan network.

<!-- Subbagian berikutnya (semantic cache/model routing/AI Gateway, Cloudflare Workflows SLA,
     memori jangka panjang + PII vault, Langfuse prompt management/online eval) ditambahkan di sini
     begitu fitur terkait selesai. -->

-- Modal Mitra Contoh — skema D1 (SEMUA DATA SINTETIS, perusahaan P2P micro-lending FIKTIF,
-- gaya LPBBTI/Grameen group-lending, TIDAK berafiliasi dengan entitas nyata manapun).

CREATE TABLE IF NOT EXISTS majelis (
  majelis_id TEXT PRIMARY KEY,
  nama TEXT NOT NULL,
  wilayah TEXT NOT NULL,            -- desa/kecamatan sintetis
  hari_pertemuan TEXT NOT NULL,     -- "Kamis", dst
  jam_pertemuan TEXT NOT NULL,
  pertemuan_berikutnya TEXT NOT NULL, -- YYYY-MM-DD
  petugas_lapangan TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mitra (
  mitra_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  nik TEXT NOT NULL,                -- NIK sintetis, checksum/struktur tidak valid, bukan data nyata
  phone TEXT NOT NULL,
  birth_date TEXT NOT NULL,         -- YYYY-MM-DD, faktor verifikasi ke-2
  majelis_id TEXT NOT NULL REFERENCES majelis(majelis_id),
  usaha TEXT NOT NULL,              -- jenis usaha mikro sintetis
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pinjaman (
  pinjaman_no TEXT PRIMARY KEY,
  mitra_id TEXT NOT NULL REFERENCES mitra(mitra_id),
  produk TEXT NOT NULL,
  pokok_pinjaman INTEGER NOT NULL,
  tenor_minggu INTEGER NOT NULL,
  angsuran_per_minggu INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'aktif', -- aktif | lunas | menunggak
  tanggal_mulai TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS angsuran (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pinjaman_no TEXT NOT NULL REFERENCES pinjaman(pinjaman_no),
  periode_no INTEGER NOT NULL,
  tanggal_jatuh_tempo TEXT NOT NULL,
  jumlah INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'belum_bayar', -- belum_bayar | lunas | terlambat
  tanggal_bayar TEXT
);

CREATE TABLE IF NOT EXISTS pendana (
  pendana_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT NOT NULL,
  birth_date TEXT NOT NULL,         -- faktor verifikasi ke-2
  risk_profile TEXT NOT NULL DEFAULT 'moderat', -- konservatif | moderat | agresif (preferensi, BUKAN rekomendasi personal AI)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pendanaan (
  pendanaan_id TEXT PRIMARY KEY,
  pendana_id TEXT NOT NULL REFERENCES pendana(pendana_id),
  majelis_id TEXT REFERENCES majelis(majelis_id),
  jumlah_didanai INTEGER NOT NULL,
  tanggal_pendanaan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'berjalan', -- menunggu_pencairan | berjalan | lunas | bermasalah
  tenor_minggu INTEGER NOT NULL,
  estimasi_imbal_hasil_pct REAL NOT NULL, -- flat/tahun, ESTIMASI bukan jaminan
  risk_tier TEXT NOT NULL DEFAULT 'B',    -- A (rendah) | B (moderat) | C (lebih tinggi)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  ticket_id TEXT PRIMARY KEY,
  actor_id TEXT,                   -- mitra_id ATAU pendana_id yang terverifikasi
  actor_type TEXT,                 -- 'mitra' | 'pendana'
  session_id TEXT,
  category TEXT NOT NULL,          -- pengaduan | hak_data | penagihan | layanan | pendanaan
  severity TEXT NOT NULL DEFAULT 'normal', -- normal | high | critical
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',     -- open | in_progress | resolved | escalated
  sla_due_at TEXT NOT NULL,        -- ringkasan SOP internal, lihat kb sop-pengaduan (tandai "perlu dicek")
  assigned_to TEXT,                -- 'AI' | nama CS
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dsr_requests (
  dsr_id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_type TEXT,
  request_type TEXT NOT NULL,      -- access | correction | delete | object_automated_decision
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted | verifying | in_progress | completed | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Permintaan restrukturisasi / keringanan: AI HANYA mencatat, TIDAK PERNAH memutuskan/menjanjikan
-- hasil (Pasal 10 UU PDP — larangan keputusan otomatis yang berdampak signifikan bagi subjek data).
CREATE TABLE IF NOT EXISTS restructuring_requests (
  restru_id TEXT PRIMARY KEY,
  mitra_id TEXT,
  pinjaman_no TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted | under_review | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log append-only, hash-chain (prev_hash -> hash) agar tamper-evident.
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  actor TEXT NOT NULL,             -- 'ai' | 'human' | 'system'
  event_type TEXT NOT NULL,        -- guard_block | retrieve | tool_call | tool_result | llm_call | handoff | output
  payload TEXT NOT NULL,           -- JSON, PII sudah diredaksi sebelum ditulis
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indeks ringan untuk konsol CS (antrean + SLA + mode). Sumber kebenaran state percakapan tetap
-- di Durable Object; tabel ini cache tampilan agar konsol tidak perlu memanggil tiap DO satu-satu.
CREATE TABLE IF NOT EXISTS sessions_index (
  session_id TEXT PRIMARY KEY,
  persona TEXT NOT NULL DEFAULT 'mitra', -- mitra | pendana | petugas
  mode TEXT NOT NULL DEFAULT 'AI',
  verified_actor_id TEXT,
  last_message TEXT,
  last_sender TEXT,
  handoff_at TEXT,
  sla_due_at TEXT,
  handoff_summary TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_documents (
  doc_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,       -- internal_policy | faq | regulation_summary
  version TEXT NOT NULL,
  needs_verification INTEGER NOT NULL DEFAULT 0, -- 1 = ringkasan regulasi, tandai "perlu dicek"
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pinjaman_mitra ON pinjaman(mitra_id);
CREATE INDEX IF NOT EXISTS idx_angsuran_pinjaman ON angsuran(pinjaman_no);
CREATE INDEX IF NOT EXISTS idx_pendanaan_pendana ON pendanaan(pendana_id);
CREATE INDEX IF NOT EXISTS idx_mitra_majelis ON mitra(majelis_id);
CREATE INDEX IF NOT EXISTS idx_tickets_actor ON tickets(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_mode ON sessions_index(mode);

-- feat/extras — fitur #4 (Cloudflare Workflows SLA/eskalasi handoff). Dicatat terpisah dari
-- `tickets` (SLA pengaduan multi-hari) & `sessions_index.sla_due_at` (badge 5 menit di konsol) —
-- tabel ini mencatat HASIL cek durable timer: apakah CS benar-benar merespons (sessions_index.
-- last_sender berubah jadi 'human') dalam N menit sejak handoff, atau terlewat (escalated).
CREATE TABLE IF NOT EXISTS sla_escalations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sla_minutes INTEGER NOT NULL,
  outcome TEXT NOT NULL,           -- 'resolved_in_time' | 'escalated'
  reason TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sla_escalations_session ON sla_escalations(session_id);

// Generator data sintetis untuk Modal Mitra Contoh (P2P micro-lending FIKTIF, gaya LPBBTI/group-lending).
// NIK sintetis SENGAJA tidak valid (checksum/struktur asli) — tidak bisa disalahartikan sebagai data nyata.
// Jalankan: npx tsx scripts/gen-data.ts -> menulis data/synthetic/{majelis,mitra,pinjaman,angsuran,pendana,pendanaan}.json + seed.sql

import { writeFileSync } from "node:fs";

const FIRST_F = ["Sri", "Yanti", "Dewi", "Lina", "Rina", "Wulan", "Indah", "Siti", "Fitri", "Ratna",
  "Ani", "Mira", "Tuti", "Nur", "Wiwik", "Lestari", "Endang", "Yuli", "Partini", "Suryani"];
const LAST = ["Wahyuni", "Kusuma", "Santoso", "Lestari", "Wijaya", "Hidayat", "Permata", "Wardani",
  "Setiawati", "Hartono", "Rahayu", "Handayani", "Mulyani", "Astuti", "Susanti"];
const MALE_FIRST = ["Andi", "Budi", "Hendra", "Taufik", "Bayu", "Eko", "Hadi", "Joko", "Agus", "Fajar"];
const USAHA = ["Warung sembako", "Jahit pakaian", "Kerajinan anyaman bambu", "Jual kue basah",
  "Budidaya lele", "Warung makan", "Jual pulsa & sembako", "Konveksi rumahan", "Jual sayur keliling", "Ternak ayam kampung"];
const WILAYAH = ["Desa Sukamaju, Kab. Bogor", "Desa Cibening, Kab. Sukabumi", "Desa Tanjung Harapan, Kab. Lampung Selatan",
  "Desa Sumber Rejo, Kab. Jombang", "Desa Karang Anyar, Kab. Gowa"];
const HARI = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat"];
const PRODUK_PINJAMAN = ["Pinjaman Modal Usaha Mikro", "Pinjaman Modal Usaha Mikro Plus"];

function pad(n: number, len: number) { return String(n).padStart(len, "0"); }
function pick<T>(arr: T[], seed: number): T { return arr[seed % arr.length]; }
function fakeNik(seed: number): string {
  // 16 digit, provinsi/kabupaten "00" dan tanggal "00" -> jelas sintetis & tidak valid.
  return `00${pad(0, 2)}${pad(0, 2)}${pad((seed % 28) + 1, 2)}${pad((seed % 12) + 1, 2)}99${pad(seed, 4)}`;
}
function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

// --- Majelis (kelompok ibu-ibu, 15-20 orang per majelis, gaya Grameen group-lending) ---
const majelis = WILAYAH.map((wilayah, i) => ({
  majelis_id: `MJL-${pad(i + 1, 3)}`,
  nama: `Majelis ${["Melati", "Mawar", "Anggrek", "Kenanga", "Dahlia"][i]} ${pad(i + 1, 2)}`,
  wilayah,
  hari_pertemuan: HARI[i],
  jam_pertemuan: "09:00",
  pertemuan_berikutnya: futureDate(((i + 1) * 2) % 7 + 1),
  petugas_lapangan: `${pick(MALE_FIRST, i + 11)} ${pick(LAST, i + 3)}`,
}));

// --- Mitra (peminjam) — 2 identitas TETAP untuk skenario demo/eval + 28 acak ---
const mitra: any[] = [];
const pinjaman: any[] = [];
const angsuran: any[] = [];

const demoMitra = [
  {
    mitra_id: "MIT-0001", full_name: "Sri Wahyuni", birth_date: "1985-03-12", phone: "081100000001",
    majelis_id: "MJL-001", usaha: "Warung sembako",
    pinjaman_no: "MMK-100001", produk: "Pinjaman Modal Usaha Mikro", pokok: 3000000, tenor_minggu: 50,
    paidPeriods: 22, lateOne: true,
  },
  {
    mitra_id: "MIT-0002", full_name: "Yanti Kusuma", birth_date: "1990-07-20", phone: "081100000002",
    majelis_id: "MJL-002", usaha: "Jahit pakaian",
    pinjaman_no: "MMK-100002", produk: "Pinjaman Modal Usaha Mikro Plus", pokok: 5000000, tenor_minggu: 50,
    paidPeriods: 40, lateOne: false,
  },
];

for (const d of demoMitra) {
  mitra.push({
    mitra_id: d.mitra_id, full_name: d.full_name, nik: fakeNik(Number(d.mitra_id.slice(-2))),
    phone: d.phone, birth_date: d.birth_date, majelis_id: d.majelis_id, usaha: d.usaha,
  });
  const weekly = Math.round((d.pokok * 1.12) / d.tenor_minggu);
  pinjaman.push({
    pinjaman_no: d.pinjaman_no, mitra_id: d.mitra_id, produk: d.produk, pokok_pinjaman: d.pokok,
    tenor_minggu: d.tenor_minggu, angsuran_per_minggu: weekly, status: "aktif", tanggal_mulai: "2025-11-03",
  });
  for (let p = 1; p <= d.tenor_minggu; p++) {
    const due = new Date(2025, 10, 3 + (p - 1) * 7).toISOString().slice(0, 10);
    let status = "belum_bayar";
    if (p <= d.paidPeriods) status = d.lateOne && p === d.paidPeriods ? "terlambat" : "lunas";
    angsuran.push({ pinjaman_no: d.pinjaman_no, periode_no: p, tanggal_jatuh_tempo: due, jumlah: weekly, status, tanggal_bayar: status === "lunas" ? due : null });
  }
}

for (let i = 3; i <= 30; i++) {
  const seed = i * 7 + 3;
  const mitra_id = `MIT-${pad(i, 4)}`;
  const full_name = `${pick(FIRST_F, seed)} ${pick(LAST, seed + 1)}`;
  const birth_date = `${1975 + (seed % 25)}-${pad((seed % 12) + 1, 2)}-${pad((seed % 27) + 1, 2)}`;
  const phone = `0811${pad(seed, 8)}`.slice(0, 12);
  const majelis_id = majelis[seed % majelis.length].majelis_id;
  const usaha = pick(USAHA, seed);
  mitra.push({ mitra_id, full_name, nik: fakeNik(seed), phone, birth_date, majelis_id, usaha });

  const pinjaman_no = `MMK-${pad(100000 + i, 6)}`;
  const produk = pick(PRODUK_PINJAMAN, seed);
  const pokok = 2000000 + (seed % 15) * 500000;
  const tenor_minggu = [25, 50][seed % 2];
  const weekly = Math.round((pokok * 1.12) / tenor_minggu);
  const paidPeriods = seed % tenor_minggu;
  pinjaman.push({
    pinjaman_no, mitra_id, produk, pokok_pinjaman: pokok, tenor_minggu, angsuran_per_minggu: weekly,
    status: paidPeriods >= tenor_minggu - 1 ? "lunas" : "aktif", tanggal_mulai: "2025-08-04",
  });
  for (let p = 1; p <= tenor_minggu; p++) {
    const due = new Date(2025, 7, 4 + (p - 1) * 7).toISOString().slice(0, 10);
    const status = p <= paidPeriods ? "lunas" : (p === paidPeriods + 1 && seed % 6 === 0 ? "terlambat" : "belum_bayar");
    angsuran.push({ pinjaman_no, periode_no: p, tanggal_jatuh_tempo: due, jumlah: weekly, status, tanggal_bayar: status === "lunas" ? due : null });
  }
}

// --- Pendana (lender/investor) — 2 identitas TETAP + 8 acak ---
const pendana: any[] = [];
const pendanaan: any[] = [];

const demoPendana = [
  { pendana_id: "PND-0001", full_name: "Andi Pratama", email: "andi.demo@example.test", phone: "081299990001", birth_date: "1992-01-15", risk_profile: "moderat" },
  { pendana_id: "PND-0002", full_name: "Budi Hartono", email: "budi.demo@example.test", phone: "081299990002", birth_date: "1988-09-09", risk_profile: "konservatif" },
];

for (const p of demoPendana) {
  pendana.push(p);
}
for (let i = 3; i <= 10; i++) {
  const seed = i * 11 + 5;
  pendana.push({
    pendana_id: `PND-${pad(i, 4)}`, full_name: `${pick(MALE_FIRST, seed)} ${pick(LAST, seed + 2)}`,
    email: null, phone: `0812${pad(seed, 8)}`.slice(0, 12),
    birth_date: `${1980 + (seed % 20)}-${pad((seed % 12) + 1, 2)}-${pad((seed % 27) + 1, 2)}`,
    risk_profile: ["konservatif", "moderat", "agresif"][seed % 3],
  });
}

let pendanaanSeq = 1;
for (const p of pendana) {
  const nFundings = 2 + (p.pendana_id.length % 3);
  for (let k = 0; k < nFundings; k++) {
    const seed = pendanaanSeq * 13 + 7;
    const m = majelis[seed % majelis.length];
    const jumlah = 2000000 + (seed % 10) * 1000000;
    const statusOpts = ["berjalan", "berjalan", "lunas", "menunggu_pencairan"];
    pendanaan.push({
      pendanaan_id: `FND-${pad(pendanaanSeq, 5)}`,
      pendana_id: p.pendana_id,
      majelis_id: m.majelis_id,
      jumlah_didanai: jumlah,
      tanggal_pendanaan: "2025-09-01",
      status: pick(statusOpts, seed),
      tenor_minggu: 50,
      estimasi_imbal_hasil_pct: [12, 13.5, 15][seed % 3],
      risk_tier: ["A", "B", "C"][seed % 3],
    });
    pendanaanSeq += 1;
  }
}

const kbDocs = [
  { doc_id: "produk", title: "Produk Pinjaman & Pendanaan", source_type: "internal_policy", version: "2026-01", needs_verification: 0 },
  { doc_id: "faq", title: "FAQ Mitra & Pendana", source_type: "faq", version: "2026-01", needs_verification: 0 },
  { doc_id: "sop-pengaduan", title: "SOP Penanganan Pengaduan & Penagihan Etis", source_type: "internal_policy", version: "2026-01", needs_verification: 0 },
  { doc_id: "risiko-pendanaan", title: "Ringkasan Risiko Pendanaan P2P", source_type: "internal_policy", version: "2026-01", needs_verification: 0 },
  { doc_id: "pojk40", title: "Ringkasan POJK 40/2024 LPBBTI", source_type: "regulation_summary", version: "ringkasan-publik-2026", needs_verification: 1 },
  { doc_id: "uu-pdp", title: "Ringkasan UU PDP 27/2022", source_type: "regulation_summary", version: "ringkasan-publik-2026", needs_verification: 1 },
  { doc_id: "privasi", title: "Kebijakan Privasi Asisten AI", source_type: "internal_policy", version: "2026-01", needs_verification: 0 },
];

function esc(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

let sql = "-- AUTO-GENERATED: data sintetis seed untuk D1. Jangan edit manual, jalankan ulang gen-data.ts\n";
sql += "DELETE FROM angsuran; DELETE FROM pinjaman; DELETE FROM mitra; DELETE FROM pendanaan; DELETE FROM pendana; DELETE FROM majelis; DELETE FROM kb_documents;\n";
for (const m of majelis) {
  sql += `INSERT INTO majelis (majelis_id, nama, wilayah, hari_pertemuan, jam_pertemuan, pertemuan_berikutnya, petugas_lapangan) VALUES (${esc(m.majelis_id)}, ${esc(m.nama)}, ${esc(m.wilayah)}, ${esc(m.hari_pertemuan)}, ${esc(m.jam_pertemuan)}, ${esc(m.pertemuan_berikutnya)}, ${esc(m.petugas_lapangan)});\n`;
}
for (const m of mitra) {
  sql += `INSERT INTO mitra (mitra_id, full_name, nik, phone, birth_date, majelis_id, usaha) VALUES (${esc(m.mitra_id)}, ${esc(m.full_name)}, ${esc(m.nik)}, ${esc(m.phone)}, ${esc(m.birth_date)}, ${esc(m.majelis_id)}, ${esc(m.usaha)});\n`;
}
for (const p of pinjaman) {
  sql += `INSERT INTO pinjaman (pinjaman_no, mitra_id, produk, pokok_pinjaman, tenor_minggu, angsuran_per_minggu, status, tanggal_mulai) VALUES (${esc(p.pinjaman_no)}, ${esc(p.mitra_id)}, ${esc(p.produk)}, ${esc(p.pokok_pinjaman)}, ${esc(p.tenor_minggu)}, ${esc(p.angsuran_per_minggu)}, ${esc(p.status)}, ${esc(p.tanggal_mulai)});\n`;
}
for (const a of angsuran) {
  sql += `INSERT INTO angsuran (pinjaman_no, periode_no, tanggal_jatuh_tempo, jumlah, status, tanggal_bayar) VALUES (${esc(a.pinjaman_no)}, ${esc(a.periode_no)}, ${esc(a.tanggal_jatuh_tempo)}, ${esc(a.jumlah)}, ${esc(a.status)}, ${esc(a.tanggal_bayar)});\n`;
}
for (const p of pendana) {
  sql += `INSERT INTO pendana (pendana_id, full_name, email, phone, birth_date, risk_profile) VALUES (${esc(p.pendana_id)}, ${esc(p.full_name)}, ${esc(p.email)}, ${esc(p.phone)}, ${esc(p.birth_date)}, ${esc(p.risk_profile)});\n`;
}
for (const f of pendanaan) {
  sql += `INSERT INTO pendanaan (pendanaan_id, pendana_id, majelis_id, jumlah_didanai, tanggal_pendanaan, status, tenor_minggu, estimasi_imbal_hasil_pct, risk_tier) VALUES (${esc(f.pendanaan_id)}, ${esc(f.pendana_id)}, ${esc(f.majelis_id)}, ${esc(f.jumlah_didanai)}, ${esc(f.tanggal_pendanaan)}, ${esc(f.status)}, ${esc(f.tenor_minggu)}, ${esc(f.estimasi_imbal_hasil_pct)}, ${esc(f.risk_tier)});\n`;
}
for (const d of kbDocs) {
  sql += `INSERT INTO kb_documents (doc_id, title, source_type, version, needs_verification) VALUES (${esc(d.doc_id)}, ${esc(d.title)}, ${esc(d.source_type)}, ${esc(d.version)}, ${esc(d.needs_verification)});\n`;
}

writeFileSync("data/synthetic/majelis.json", JSON.stringify(majelis, null, 2));
writeFileSync("data/synthetic/mitra.json", JSON.stringify(mitra, null, 2));
writeFileSync("data/synthetic/pinjaman.json", JSON.stringify(pinjaman, null, 2));
writeFileSync("data/synthetic/angsuran.json", JSON.stringify(angsuran, null, 2));
writeFileSync("data/synthetic/pendana.json", JSON.stringify(pendana, null, 2));
writeFileSync("data/synthetic/pendanaan.json", JSON.stringify(pendanaan, null, 2));
writeFileSync("data/synthetic/seed.sql", sql);

console.log(`Generated ${majelis.length} majelis, ${mitra.length} mitra, ${pinjaman.length} pinjaman, ${angsuran.length} angsuran, ${pendana.length} pendana, ${pendanaan.length} pendanaan, ${kbDocs.length} kb docs.`);
console.log("Identitas demo untuk skenario live + eval:");
for (const d of demoMitra) console.log(`  MITRA ${d.mitra_id} | pinjaman=${d.pinjaman_no} | birth_date=${d.birth_date} | nama=${d.full_name}`);
for (const d of demoPendana) console.log(`  PENDANA ${d.pendana_id} | birth_date=${d.birth_date} | nama=${d.full_name}`);

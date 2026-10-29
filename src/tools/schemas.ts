import { z } from "zod";

// Skema argumen tool — SELALU divalidasi sebelum eksekusi. Argumen dari LLM tidak dipercaya untuk
// otorisasi: actor_id operasi aktual diambil dari state sesi terverifikasi di Durable Object,
// bukan dari argumen yang diisi LLM (lihat agent/toolAgent.ts).

export const VerifyMitraSchema = z.object({
  pinjaman_no: z.string().min(5).max(20),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "format YYYY-MM-DD"),
});

export const VerifyPendanaSchema = z.object({
  pendana_id: z.string().min(5).max(20),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "format YYYY-MM-DD"),
});

export const GetAngsuranSchema = z.object({
  only_unpaid: z.boolean().optional().default(false),
});

export const GetMajelisInfoSchema = z.object({});

export const GetPortofolioSchema = z.object({});

export const CreateComplaintTicketSchema = z.object({
  category: z.enum(["layanan", "penagihan", "produk", "data_pribadi", "pendanaan"]),
  severity: z.enum(["normal", "high", "critical"]).default("normal"),
  subject: z.string().min(3).max(120),
  description: z.string().min(5).max(2000),
});

export const CreateDsrRequestSchema = z.object({
  request_type: z.enum(["access", "correction", "delete", "object_automated_decision"]),
  detail: z.string().max(2000).optional(),
});

export const CreateRestructuringRequestSchema = z.object({
  reason: z.string().min(3).max(500),
});

export const HandoffToHumanSchema = z.object({
  reason: z.string().min(3).max(300),
});

export const TOOL_REGISTRY = {
  verify_mitra: {
    schema: VerifyMitraSchema,
    description: "Verifikasi identitas MITRA (peminjam) dengan nomor pinjaman + tanggal lahir (YYYY-MM-DD). WAJIB sebelum tool akun mitra lain.",
  },
  verify_pendana: {
    schema: VerifyPendanaSchema,
    description: "Verifikasi identitas PENDANA dengan ID pendana + tanggal lahir (YYYY-MM-DD). WAJIB sebelum tool portofolio.",
  },
  get_angsuran: {
    schema: GetAngsuranSchema,
    description: "Ambil rincian angsuran mitra yang SUDAH terverifikasi di sesi ini. only_unpaid=true untuk hanya yang belum lunas.",
  },
  get_majelis_info: {
    schema: GetMajelisInfoSchema,
    description: "Ambil info majelis (nama, wilayah, jadwal pertemuan berikutnya, petugas lapangan) milik mitra yang terverifikasi. TIDAK PERNAH menyertakan data pribadi/finansial anggota lain.",
  },
  get_portofolio: {
    schema: GetPortofolioSchema,
    description: "Ambil ringkasan portofolio pendanaan milik pendana yang SUDAH terverifikasi (jumlah didanai, status, risk tier, estimasi imbal hasil).",
  },
  create_complaint_ticket: {
    schema: CreateComplaintTicketSchema,
    description: "Buat tiket pengaduan dengan kategori, severity, subjek, dan deskripsi. SLA tenggat dihitung otomatis.",
  },
  create_dsr_request: {
    schema: CreateDsrRequestSchema,
    description: "Catat permintaan hak subjek data (akses/koreksi/hapus/keberatan keputusan otomatis) sesuai UU PDP. TIDAK dieksekusi otomatis.",
  },
  create_restructuring_request: {
    schema: CreateRestructuringRequestSchema,
    description: "Catat permintaan restrukturisasi/keringanan angsuran mitra untuk ditinjau petugas lapangan. TIDAK PERNAH menjanjikan hasil/keputusan.",
  },
  handoff_to_human: {
    schema: HandoffToHumanSchema,
    description: "Alihkan percakapan ke CS manusia dengan alasan eskalasi (HITL).",
  },
} as const;

export type ToolName = keyof typeof TOOL_REGISTRY;

// LLM kadang memakai nama field sinonim walau sudah diberi skema persis (diamati: Qwen3 memakai
// variasi penamaan). Daripada menolak permintaan yang jelas-jelas valid secara maksud, normalisasi
// alias umum dulu sebelum validasi Zod -> Zod tetap jadi penjaga kebenaran tipe/format.
const FIELD_ALIASES: Record<string, string> = {
  contract_number: "pinjaman_no",
  loan_no: "pinjaman_no",
  no_pinjaman: "pinjaman_no",
  nomor_pinjaman: "pinjaman_no",
  investor_id: "pendana_id",
  id_pendana: "pendana_id",
  date_of_birth: "birth_date",
  tanggal_lahir: "birth_date",
  dob: "birth_date",
  description: "detail", // create_dsr_request: LLM kadang memakai "description" padahal skema "detail"
};

const ENUM_VALUE_ALIASES: Record<string, string> = {
  hapus: "delete",
  akses: "access",
  koreksi: "correction",
  keberatan: "object_automated_decision",
};

export function normalizeToolArgs(args: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    const key = FIELD_ALIASES[k] ?? k;
    out[key] = typeof v === "string" && ENUM_VALUE_ALIASES[v.toLowerCase()] ? ENUM_VALUE_ALIASES[v.toLowerCase()] : v;
  }
  return out;
}

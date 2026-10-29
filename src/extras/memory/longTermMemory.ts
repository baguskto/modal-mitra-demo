// Fitur #5: memori jangka panjang per mitra/pendana (ringkasan preferensi/pola komunikasi lintas
// sesi), WAJIB persetujuan eksplisit dulu (consent-gated di SETIAP operasi baca/tulis, bukan cuma
// saat pertama kali), dan bisa dihapus kapan saja (hak subjek data — selaras intent `hak_data`/
// tool `create_dsr_request` yang SUDAH ADA, lihat src/tools/execute.ts — modul ini tidak
// menduplikasi tool itu, hanya menyediakan storage+API memori yang terpisah).
//
// Koordinasi PII vault: saat worktree ini ditulis, worker inti BELUM membuat PII vault khusus
// (S4 di plan keamanan, belum committed). Sebagai pagar minimum sekarang, setiap `summary` WAJIB
// lolos `scanOutputForPII` (guard yang sudah ada, src/guards/pii.ts) sebelum disimpan — menolak
// simpan bila ada NIK/kartu/email/HP mentah. BILA/SAAT PII vault dedicated sudah ada, storage di
// sini sebaiknya diarahkan lewat vault itu (tokenisasi) alih-alih redaksi manual — dicatat sebagai
// TODO integrasi di README §11.5, bukan diam-diam diasumsikan sudah terjadi.
import { scanOutputForPII } from "../../guards/pii";
import { xrayEvent, type ExtrasXrayEvent } from "../xray";

export interface MemoryEnv {
  DB: D1Database;
}

export type ActorType = "mitra" | "pendana";

interface MemoryRow {
  actor_id: string;
  actor_type: ActorType;
  summary: string | null;
  consent_given: number;
  consent_at: string | null;
  updated_at: string;
}

export interface MemoryRecord {
  actorId: string;
  actorType: ActorType;
  summary: string | null;
  consentGiven: boolean;
  consentAt: string | null;
  updatedAt: string;
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    actorId: row.actor_id,
    actorType: row.actor_type,
    summary: row.summary,
    consentGiven: Boolean(row.consent_given),
    consentAt: row.consent_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persetujuan diberikan ATAU ditarik. Menarik persetujuan (granted=false) langsung MENGHAPUS
 * isi memori (bukan hanya menandai nonaktif) — "hak hapus" harus benar-benar menghapus data,
 * bukan menyembunyikannya saja di balik flag.
 */
export async function setConsent(
  env: MemoryEnv,
  actorId: string,
  actorType: ActorType,
  granted: boolean,
): Promise<MemoryRecord> {
  const now = new Date().toISOString();

  if (!granted) {
    // Penarikan persetujuan = penghapusan langsung isi memori, bukan sekadar flag nonaktif.
    await env.DB.prepare(`DELETE FROM long_term_memory WHERE actor_id = ?`).bind(actorId).run();
  }

  // Semua kolom dibind sebagai placeholder EKSPLISIT (tidak mencampur literal SQL inline dengan
  // `?` posisional) — lebih aman terhadap kesalahan urutan argumen saat kolom berubah di masa depan.
  await env.DB.prepare(
    `INSERT INTO long_term_memory (actor_id, actor_type, summary, consent_given, consent_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(actor_id) DO UPDATE SET consent_given = excluded.consent_given, consent_at = excluded.consent_at, updated_at = excluded.updated_at`,
  )
    .bind(actorId, actorType, null, granted ? 1 : 0, now, now)
    .run();

  return { actorId, actorType, summary: null, consentGiven: granted, consentAt: now, updatedAt: now };
}

export async function getMemory(
  env: MemoryEnv,
  actorId: string,
  sessionId?: string,
): Promise<{ record: MemoryRecord | null; xray: ExtrasXrayEvent }> {
  const row = await env.DB.prepare(`SELECT * FROM long_term_memory WHERE actor_id = ?`).bind(actorId).first<MemoryRow>();
  if (!row || !row.consent_given) {
    return { record: null, xray: xrayEvent("memory_read", { found: false }, sessionId) };
  }
  const record = toRecord(row);
  return { record, xray: xrayEvent("memory_read", { found: true, hasSummary: Boolean(record.summary) }, sessionId) };
}

export interface SaveMemoryResult {
  saved: boolean;
  reason?: string;
  xray: ExtrasXrayEvent;
}

/** Pagar murni (tanpa I/O D1) dipakai oleh saveMemorySummary — diekspos agar bisa dites/dieval
 * langsung tanpa mock D1 (lihat evals/extras-eval.yaml, scripts/run-extras-eval.ts). */
export function evaluateMemoryWrite(consentGiven: boolean, summary: string): { allowed: boolean; reason?: string } {
  if (!consentGiven) return { allowed: false, reason: "no_consent" };
  const piiScan = scanOutputForPII(summary);
  if (!piiScan.clean) return { allowed: false, reason: `pii_detected: ${piiScan.findings.join(", ")}` };
  return { allowed: true };
}

export async function saveMemorySummary(
  env: MemoryEnv,
  actorId: string,
  actorType: ActorType,
  summary: string,
  sessionId?: string,
): Promise<SaveMemoryResult> {
  const existing = await env.DB.prepare(`SELECT consent_given FROM long_term_memory WHERE actor_id = ?`).bind(actorId).first<{ consent_given: number }>();
  const gate = evaluateMemoryWrite(Boolean(existing?.consent_given), summary);
  if (!gate.allowed) {
    const xrayReason = gate.reason === "no_consent" ? "no_consent" : "pii_detected";
    return { saved: false, reason: gate.reason, xray: xrayEvent("memory_write", { saved: false, reason: xrayReason }, sessionId) };
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE long_term_memory SET summary = ?, updated_at = ? WHERE actor_id = ?`,
  )
    .bind(summary, now, actorId)
    .run();
  return { saved: true, xray: xrayEvent("memory_write", { saved: true }, sessionId) };
}

export async function deleteMemory(env: MemoryEnv, actorId: string, sessionId?: string): Promise<{ deleted: boolean; xray: ExtrasXrayEvent }> {
  await env.DB.prepare(`DELETE FROM long_term_memory WHERE actor_id = ?`).bind(actorId).run();
  return { deleted: true, xray: xrayEvent("memory_deleted", { actorId }, sessionId) };
}

// Audit log append-only dengan hash-chain (mirip blockchain sederhana) agar tamper-evident:
// setiap baris menyimpan MAC(prev_mac + payload + timestamp). Mengubah/menghapus baris lama
// akan merusak rantai MAC baris-baris setelahnya -> terdeteksi oleh verifyChain().
//
// v2: MAC sekarang HMAC-SHA256 dengan kunci rahasia (`AUDIT_HMAC_KEY`, wrangler secret), BUKAN
// SHA-256 polos seperti v1 (gap yang sudah didokumentasikan sejak README v1 §7: "hash tanpa kunci
// rahasia, bisa dihitung ulang oleh siapa pun berakses tulis D1"). Kunci dikonfigurasi SEKALI per
// cold-start lewat `configureAuditHmac()` (dipanggil dari `ChatAgent.onStart()`) supaya TIDAK perlu
// mengubah signature setiap pemanggil `appendAuditLog` yang sudah ada (puluhan titik panggil di
// src/agent/graph.ts) — kunci hidup sebagai modul-level state per isolate, bukan diteruskan manual.
// Tanpa kunci (demo lokal tanpa secret di-set), fallback ke SHA-256 polos — didokumentasikan sebagai
// degradasi eksplisit, BUKAN default yang direkomendasikan untuk demo yang dibagikan ke pewawancara.

let hmacKeyPromise: Promise<CryptoKey> | null = null;
let configuredKey: string | null = null;

export function configureAuditHmac(key: string | undefined | null): void {
  if (!key || configuredKey === key) return;
  configuredKey = key;
  hmacKeyPromise = crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export function auditHmacConfigured(): boolean {
  return hmacKeyPromise !== null;
}

async function computeMac(input: string): Promise<string> {
  if (hmacKeyPromise) {
    const key = await hmacKeyPromise;
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const GENESIS_HASH = "0".repeat(64);

export async function appendAuditLog(
  db: D1Database,
  sessionId: string,
  actor: "ai" | "human" | "system",
  eventType: string,
  payload: Record<string, any>,
): Promise<{ seq: number; hash: string }> {
  const prevRow = await db
    .prepare(`SELECT hash FROM audit_log WHERE session_id = ? ORDER BY seq DESC LIMIT 1`)
    .bind(sessionId)
    .first<{ hash: string }>();
  const prevHash = prevRow?.hash ?? GENESIS_HASH;
  const createdAt = new Date().toISOString();
  const payloadJson = JSON.stringify(payload);
  const hash = await computeMac(prevHash + payloadJson + createdAt);

  const res = await db
    .prepare(
      `INSERT INTO audit_log (session_id, actor, event_type, payload, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(sessionId, actor, eventType, payloadJson, prevHash, hash, createdAt)
    .run();

  return { seq: Number(res.meta.last_row_id), hash };
}

export async function verifyChain(db: D1Database, sessionId: string): Promise<{ valid: boolean; brokenAtSeq?: number; hmacEnabled: boolean }> {
  const rows = await db
    .prepare(`SELECT seq, payload, prev_hash, hash, created_at FROM audit_log WHERE session_id = ? ORDER BY seq ASC`)
    .bind(sessionId)
    .all<{ seq: number; payload: string; prev_hash: string; hash: string; created_at: string }>();

  let expectedPrev = GENESIS_HASH;
  for (const row of rows.results) {
    if (row.prev_hash !== expectedPrev) return { valid: false, brokenAtSeq: row.seq, hmacEnabled: auditHmacConfigured() };
    const recomputed = await computeMac(row.prev_hash + row.payload + row.created_at);
    if (recomputed !== row.hash) return { valid: false, brokenAtSeq: row.seq, hmacEnabled: auditHmacConfigured() };
    expectedPrev = row.hash;
  }
  return { valid: true, hmacEnabled: auditHmacConfigured() };
}

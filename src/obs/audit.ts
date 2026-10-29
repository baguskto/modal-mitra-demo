// Audit log append-only dengan hash-chain (mirip blockchain sederhana) agar tamper-evident:
// setiap baris menyimpan hash(prev_hash + payload + timestamp). Mengubah/menghapus baris lama
// akan merusak rantai hash baris-baris setelahnya -> terdeteksi oleh verifyChain().

async function sha256Hex(input: string): Promise<string> {
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
  const hash = await sha256Hex(prevHash + payloadJson + createdAt);

  const res = await db
    .prepare(
      `INSERT INTO audit_log (session_id, actor, event_type, payload, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(sessionId, actor, eventType, payloadJson, prevHash, hash, createdAt)
    .run();

  return { seq: Number(res.meta.last_row_id), hash };
}

export async function verifyChain(db: D1Database, sessionId: string): Promise<{ valid: boolean; brokenAtSeq?: number }> {
  const rows = await db
    .prepare(`SELECT seq, payload, prev_hash, hash, created_at FROM audit_log WHERE session_id = ? ORDER BY seq ASC`)
    .bind(sessionId)
    .all<{ seq: number; payload: string; prev_hash: string; hash: string; created_at: string }>();

  let expectedPrev = GENESIS_HASH;
  for (const row of rows.results) {
    if (row.prev_hash !== expectedPrev) return { valid: false, brokenAtSeq: row.seq };
    const recomputed = await sha256Hex(row.prev_hash + row.payload + row.created_at);
    if (recomputed !== row.hash) return { valid: false, brokenAtSeq: row.seq };
    expectedPrev = row.hash;
  }
  return { valid: true };
}

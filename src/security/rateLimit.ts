// Rate limit kasar per-IP untuk pengunjung PUBLIK (lindungi kuota Workers AI/Kenari dari
// scraping/abuse setelah demo dibagikan ke pewawancara — lihat visibility-rules.md). Presenter
// (Bagus) TIDAK dibatasi (lihat pemanggil di src/index.ts, dicek lebih dulu). Fail-open bila
// tabel belum ada / D1 error — observability keamanan tambahan tidak boleh menjatuhkan demo.
const WINDOW_MINUTES = 10;

export async function checkIpRateLimit(db: D1Database, ip: string, bucket: string, limit: number): Promise<{ ok: boolean; count: number }> {
  const bucketMs = WINDOW_MINUTES * 60_000;
  const windowStart = new Date(Math.floor(Date.now() / bucketMs) * bucketMs).toISOString();
  const actorKey = `ip:${ip}:${bucket}`;
  try {
    await db
      .prepare(
        `INSERT INTO tool_rate_window (actor_key, tool_name, window_start, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(actor_key, tool_name, window_start) DO UPDATE SET count = count + 1`,
      )
      .bind(actorKey, `public_${bucket}`, windowStart)
      .run();
    const row = await db.prepare(`SELECT count FROM tool_rate_window WHERE actor_key=? AND tool_name=? AND window_start=?`).bind(actorKey, `public_${bucket}`, windowStart).first<{ count: number }>();
    const count = row?.count ?? 0;
    return { ok: count <= limit, count };
  } catch {
    return { ok: true, count: 0 };
  }
}

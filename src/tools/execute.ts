import type { ToolName } from "./schemas";

export interface SessionAuthContext {
  verifiedActorId: string | null;
  actorType: "mitra" | "pendana" | null;
  sessionId: string;
}

function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

function slaDaysFor(severity: string): number {
  if (severity === "critical") return 1; // dieskalasi ke manusia, bukan ditunggu AI
  if (severity === "high") return 5;
  return 10; // default ringkasan SOP (lihat kb sop-pengaduan — tandai "perlu dicek")
}

export async function executeTool(
  db: D1Database,
  toolName: ToolName,
  args: Record<string, any>,
  ctx: SessionAuthContext,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  switch (toolName) {
    case "verify_mitra": {
      const row = await db
        .prepare(
          `SELECT p.mitra_id, m.birth_date FROM pinjaman p
           JOIN mitra m ON m.mitra_id = p.mitra_id
           WHERE p.pinjaman_no = ?`,
        )
        .bind(args.pinjaman_no)
        .first<{ mitra_id: string; birth_date: string }>();
      if (!row || row.birth_date !== args.birth_date) {
        return { ok: false, error: "Nomor pinjaman atau tanggal lahir tidak cocok." };
      }
      return { ok: true, data: { verified: true, actor_type: "mitra", actor_id: row.mitra_id } };
    }

    case "verify_pendana": {
      const row = await db
        .prepare(`SELECT pendana_id, birth_date FROM pendana WHERE pendana_id = ?`)
        .bind(args.pendana_id)
        .first<{ pendana_id: string; birth_date: string }>();
      if (!row || row.birth_date !== args.birth_date) {
        return { ok: false, error: "ID pendana atau tanggal lahir tidak cocok." };
      }
      return { ok: true, data: { verified: true, actor_type: "pendana", actor_id: row.pendana_id } };
    }

    case "get_angsuran": {
      if (ctx.actorType !== "mitra" || !ctx.verifiedActorId) return { ok: false, error: "Identitas mitra belum terverifikasi." };
      const onlyUnpaid = !!args.only_unpaid;
      const rows = await db
        .prepare(
          `SELECT a.pinjaman_no, a.periode_no, a.tanggal_jatuh_tempo, a.jumlah, a.status FROM angsuran a
           JOIN pinjaman p ON p.pinjaman_no = a.pinjaman_no
           WHERE p.mitra_id = ? ${onlyUnpaid ? "AND a.status != 'lunas'" : ""}
           ORDER BY a.pinjaman_no, a.periode_no`,
        )
        .bind(ctx.verifiedActorId)
        .all();
      const remaining = rows.results.filter((r: any) => r.status !== "lunas");
      const totalRemaining = remaining.reduce((s: number, r: any) => s + (r.jumlah as number), 0);
      return { ok: true, data: { angsuran: rows.results, remaining_count: remaining.length, remaining_total: totalRemaining } };
    }

    case "get_majelis_info": {
      if (ctx.actorType !== "mitra" || !ctx.verifiedActorId) return { ok: false, error: "Identitas mitra belum terverifikasi." };
      // SENGAJA hanya mengambil info majelis (jadwal, petugas), TIDAK PERNAH join ke data pribadi/finansial anggota lain.
      const row = await db
        .prepare(
          `SELECT mj.majelis_id, mj.nama, mj.wilayah, mj.hari_pertemuan, mj.jam_pertemuan, mj.pertemuan_berikutnya, mj.petugas_lapangan
           FROM mitra m JOIN majelis mj ON mj.majelis_id = m.majelis_id WHERE m.mitra_id = ?`,
        )
        .bind(ctx.verifiedActorId)
        .first();
      if (!row) return { ok: false, error: "Majelis tidak ditemukan." };
      return { ok: true, data: row };
    }

    case "get_portofolio": {
      if (ctx.actorType !== "pendana" || !ctx.verifiedActorId) return { ok: false, error: "Identitas pendana belum terverifikasi." };
      const rows = await db
        .prepare(
          `SELECT f.pendanaan_id, f.majelis_id, mj.nama AS majelis_nama, f.jumlah_didanai, f.tanggal_pendanaan, f.status, f.tenor_minggu, f.estimasi_imbal_hasil_pct, f.risk_tier
           FROM pendanaan f LEFT JOIN majelis mj ON mj.majelis_id = f.majelis_id
           WHERE f.pendana_id = ? ORDER BY f.tanggal_pendanaan DESC`,
        )
        .bind(ctx.verifiedActorId)
        .all();
      const totalDidanai = rows.results.reduce((s: number, r: any) => s + (r.jumlah_didanai as number), 0);
      return { ok: true, data: { pendanaan: rows.results, total_didanai: totalDidanai, count: rows.results.length } };
    }

    case "create_complaint_ticket": {
      const ticketId = `TCK-${Date.now().toString(36).toUpperCase()}`;
      const due = addBusinessDays(new Date(), slaDaysFor(args.severity ?? "normal")).toISOString();
      await db
        .prepare(
          `INSERT INTO tickets (ticket_id, actor_id, actor_type, session_id, category, severity, subject, description, status, sla_due_at, assigned_to)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 'AI')`,
        )
        .bind(ticketId, ctx.verifiedActorId, ctx.actorType, ctx.sessionId, args.category, args.severity ?? "normal", args.subject, args.description, due)
        .run();
      return { ok: true, data: { ticket_id: ticketId, sla_due_at: due, severity: args.severity ?? "normal" } };
    }

    case "create_dsr_request": {
      const dsrId = `DSR-${Date.now().toString(36).toUpperCase()}`;
      await db
        .prepare(`INSERT INTO dsr_requests (dsr_id, actor_id, actor_type, request_type, detail, status) VALUES (?, ?, ?, ?, ?, 'submitted')`)
        .bind(dsrId, ctx.verifiedActorId, ctx.actorType, args.request_type, args.detail ?? null)
        .run();
      return { ok: true, data: { dsr_id: dsrId, status: "submitted", note: "Permintaan dicatat, akan ditindaklanjuti tim berwenang. Tidak dieksekusi otomatis oleh AI." } };
    }

    case "create_restructuring_request": {
      if (ctx.actorType !== "mitra" || !ctx.verifiedActorId) return { ok: false, error: "Identitas mitra belum terverifikasi." };
      const restruId = `RST-${Date.now().toString(36).toUpperCase()}`;
      const loanRow = await db.prepare(`SELECT pinjaman_no FROM pinjaman WHERE mitra_id = ? ORDER BY tanggal_mulai DESC LIMIT 1`).bind(ctx.verifiedActorId).first<{ pinjaman_no: string }>();
      await db
        .prepare(`INSERT INTO restructuring_requests (restru_id, mitra_id, pinjaman_no, reason, status) VALUES (?, ?, ?, ?, 'submitted')`)
        .bind(restruId, ctx.verifiedActorId, loanRow?.pinjaman_no ?? null, args.reason)
        .run();
      return { ok: true, data: { restru_id: restruId, status: "submitted", note: "Permintaan restrukturisasi dicatat untuk ditinjau petugas lapangan/tim kredit. TIDAK ada keputusan otomatis." } };
    }

    case "handoff_to_human": {
      return { ok: true, data: { handoff: true, reason: args.reason } };
    }

    default:
      return { ok: false, error: `Tool tidak dikenal: ${toolName}` };
  }
}

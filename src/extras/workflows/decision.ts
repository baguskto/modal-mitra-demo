// Logika murni (TANPA import "cloudflare:workers", supaya bisa diuji langsung di vitest/node
// tanpa runtime workerd) dipisah dari kelas WorkflowEntrypoint di slaEscalationWorkflow.ts, yang
// hanya membungkus fungsi-fungsi ini dengan I/O step.do/D1.

export interface SessionRow {
  mode: string;
  last_sender: string | null;
  handoff_at: string | null;
}

export interface EscalationDecision {
  outcome: "escalated" | "resolved_in_time";
  reason: string;
}

export function decideEscalation(row: SessionRow | null, slaMinutes: number): EscalationDecision {
  const csResponded = row?.last_sender === "human";
  const stillWaitingForHuman = row?.mode === "HUMAN" && !csResponded;
  return stillWaitingForHuman
    ? { outcome: "escalated", reason: `CS belum merespons dalam ${slaMinutes} menit sejak handoff` }
    : { outcome: "resolved_in_time", reason: csResponded ? "CS sudah membalas" : "sesi sudah tidak menunggu CS" };
}

export interface NotifyEnv {
  SLA_NOTIFY_WEBHOOK_URL?: string;
}

/**
 * Notifikasi: hasil pengecekan SELALU sudah tercatat di D1 (`sla_escalations`, sumber kebenaran)
 * sebelum fungsi ini dipanggil; POST webhook di sini murni opsional (mis. Slack/Discord incoming
 * webhook) bila dikonfigurasi. Tanpa webhook (default demo, belum ada channel notifikasi nyata
 * disediakan), melaporkan `notified:false` secara jujur, BUKAN diam-diam dianggap berhasil.
 */
export async function notifyEscalation(
  env: NotifyEnv,
  payload: { id: string; sessionId: string; reason: string },
): Promise<{ notified: boolean }> {
  if (!env.SLA_NOTIFY_WEBHOOK_URL) return { notified: false };
  try {
    await fetch(env.SLA_NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `SLA handoff terlewat — sesi ${payload.sessionId}: ${payload.reason}` }),
    });
    return { notified: true };
  } catch {
    return { notified: false };
  }
}

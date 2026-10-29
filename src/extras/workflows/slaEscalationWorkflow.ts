// Fitur #4: Cloudflare Workflows untuk SLA/eskalasi handoff — timer DURABLE (bertahan lintas
// restart/deploy Worker, tidak seperti setTimeout biasa) yang menyala N menit setelah handoff ke
// CS, lalu mengecek APAKAH CS sudah membalas. Sinyal "CS sudah membalas" dipakai dari kolom yang
// SUDAH ADA & stabil di `sessions_index` (last_sender, mode) — modul ini SENGAJA tidak menyentuh
// ChatSession/ChatAgent (masih aktif ditulis ulang oleh worker inti) untuk set status "diambil";
// cukup baca state yang sudah disinkronkan. Logika keputusan murni ada di decision.ts (dites
// langsung tanpa runtime workerd); file ini hanya membungkusnya dgn step.do/D1 I/O.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { xrayEvent } from "../xray";
import { decideEscalation, notifyEscalation, type SessionRow } from "./decision";

export interface SlaWorkflowEnv {
  DB: D1Database;
  SLA_NOTIFY_WEBHOOK_URL?: string;
}

export interface SlaWorkflowParams {
  sessionId: string;
  slaMinutes: number;
}

export class SlaEscalationWorkflow extends WorkflowEntrypoint<SlaWorkflowEnv, SlaWorkflowParams> {
  async run(event: WorkflowEvent<SlaWorkflowParams>, step: WorkflowStep) {
    const { sessionId, slaMinutes } = event.payload;

    await step.sleep("wait-for-sla-window", `${slaMinutes} minutes`);

    const outcome = await step.do("check-and-escalate", async () => {
      const row = await this.env.DB.prepare(
        `SELECT mode, last_sender, handoff_at FROM sessions_index WHERE session_id = ?`,
      )
        .bind(sessionId)
        .first<SessionRow>();

      const result = decideEscalation(row, slaMinutes);

      const id = `sla-${sessionId}-${Date.now().toString(36)}`;
      await this.env.DB.prepare(
        `INSERT INTO sla_escalations (id, session_id, sla_minutes, outcome, reason) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(id, sessionId, slaMinutes, result.outcome, result.reason)
        .run();

      return { id, sessionId, ...result };
    });

    if (outcome.outcome === "escalated") {
      await step.do("notify", async () => {
        await notifyEscalation(this.env, outcome);
      });
    }

    return { ...outcome, xray: xrayEvent(outcome.outcome === "escalated" ? "sla_escalated" : "sla_timer", { ...outcome }, sessionId) };
  }
}

export { decideEscalation, notifyEscalation };

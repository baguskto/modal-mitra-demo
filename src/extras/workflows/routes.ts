import { Hono } from "hono";
import { readFeatureFlags, type ExtrasEnv } from "../config";
import type { SlaWorkflowEnv, SlaWorkflowParams } from "./slaEscalationWorkflow";

export interface WorkflowsRoutesEnv extends SlaWorkflowEnv, ExtrasEnv {
  SLA_WORKFLOW: Workflow<SlaWorkflowParams>;
}

/**
 * Titik integrasi untuk worker inti: panggil `POST /api/extras/sla/start` SEKALI, tepat saat
 * `handoff.triggered` (titik yang sudah ada di toolAgent.ts/graph.ts — lihat README §7 poin #4),
 * dengan body `{sessionId}`. Workflow durable yang menyala N menit kemudian TIDAK butuh proses
 * Worker tetap hidup (beda dari setTimeout) — aman untuk free tier & cold start.
 */
export function buildSlaRoutes() {
  const app = new Hono<{ Bindings: WorkflowsRoutesEnv }>();

  app.post("/sla/start", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.slaWorkflow) return c.json({ error: "feature_disabled" }, 404);

    const body = await c.req
      .json<{ sessionId?: string; slaMinutes?: number }>()
      .catch(() => ({} as { sessionId?: string; slaMinutes?: number }));
    if (!body.sessionId) return c.json({ error: "missing_sessionId" }, 400);

    const slaMinutes = body.slaMinutes ?? Number(c.env.SLA_MINUTES ?? 5);
    const instance = await c.env.SLA_WORKFLOW.create({
      params: { sessionId: body.sessionId, slaMinutes },
    });
    return c.json({ started: true, instanceId: instance.id, slaMinutes });
  });

  app.get("/sla/escalations", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.slaWorkflow) return c.json({ error: "feature_disabled" }, 404);

    const unresolvedOnly = c.req.query("unresolved") === "true";
    const query = unresolvedOnly
      ? `SELECT * FROM sla_escalations WHERE outcome = 'escalated' ORDER BY checked_at DESC LIMIT 50`
      : `SELECT * FROM sla_escalations ORDER BY checked_at DESC LIMIT 50`;
    const result = await c.env.DB.prepare(query).all();
    return c.json({ escalations: result.results });
  });

  return app;
}

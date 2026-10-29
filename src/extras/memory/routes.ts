import { Hono } from "hono";
import { readFeatureFlags, type ExtrasEnv } from "../config";
import { setConsent, getMemory, saveMemorySummary, deleteMemory, type MemoryEnv, type ActorType } from "./longTermMemory";

export type MemoryRoutesEnv = MemoryEnv & ExtrasEnv;

/**
 * Semua endpoint di sini TIDAK pernah dipanggil otomatis oleh AI tanpa persetujuan eksplisit —
 * `actor_id` harus sudah terverifikasi oleh sesi (sama seperti tools/execute.ts), diteruskan oleh
 * pemanggil (worker inti), TIDAK dipercaya dari klaim bebas di body request.
 */
export function buildMemoryRoutes() {
  const app = new Hono<{ Bindings: MemoryRoutesEnv }>();

  app.post("/memory/:actorId/consent", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.longTermMemory) return c.json({ error: "feature_disabled" }, 404);
    const actorId = c.req.param("actorId");
    const body = await c.req
      .json<{ actorType?: ActorType; granted?: boolean }>()
      .catch(() => ({} as { actorType?: ActorType; granted?: boolean }));
    if (!body.actorType || typeof body.granted !== "boolean") {
      return c.json({ error: "missing_actorType_or_granted" }, 400);
    }
    const record = await setConsent(c.env, actorId, body.actorType, body.granted);
    return c.json({ record });
  });

  app.get("/memory/:actorId", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.longTermMemory) return c.json({ error: "feature_disabled" }, 404);
    const actorId = c.req.param("actorId");
    const { record, xray } = await getMemory(c.env, actorId);
    return c.json({ record, xray });
  });

  app.post("/memory/:actorId", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.longTermMemory) return c.json({ error: "feature_disabled" }, 404);
    const actorId = c.req.param("actorId");
    const body = await c.req
      .json<{ actorType?: ActorType; summary?: string }>()
      .catch(() => ({} as { actorType?: ActorType; summary?: string }));
    if (!body.actorType || !body.summary) return c.json({ error: "missing_actorType_or_summary" }, 400);
    const result = await saveMemorySummary(c.env, actorId, body.actorType, body.summary);
    return c.json(result);
  });

  // Hak hapus (UU PDP) — penghapusan langsung, tanpa soft-delete/flag.
  app.delete("/memory/:actorId", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.longTermMemory) return c.json({ error: "feature_disabled" }, 404);
    const actorId = c.req.param("actorId");
    const result = await deleteMemory(c.env, actorId);
    return c.json(result);
  });

  return app;
}

import { Hono } from "hono";
import { readFeatureFlags, type ExtrasEnv } from "../config";
import { routeComplete, estimateComplexity, type RouterEnv } from "./modelRouter";
import { getCachedAnswer, storeCachedAnswer, type SemanticCacheEnv } from "./semanticCache";

export type CacheRoutesEnv = RouterEnv & SemanticCacheEnv & ExtrasEnv;

/**
 * Antarmuka independen (debug/demo) untuk panel X-Ray & integrasi bertahap oleh worker inti.
 * Pemanggilan "sungguhan" dari alur chat sebaiknya memanggil langsung `routeComplete` /
 * `getCachedAnswer` dari node graph (lebih hemat 1 HTTP hop) — endpoint di bawah terutama untuk
 * demo panel "hemat biaya/latensi" & smoke test independen dari ChatAgent.
 */
export function buildCacheRoutes() {
  const app = new Hono<{ Bindings: CacheRoutesEnv }>();

  app.post("/cache/lookup", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.semanticCache) return c.json({ error: "feature_disabled" }, 404);
    const body = await c.req.json<{ query?: string; persona?: string }>().catch(() => ({} as { query?: string; persona?: string }));
    if (!body.query || !body.persona) return c.json({ error: "missing_query_or_persona" }, 400);
    const result = await getCachedAnswer(c.env, { query: body.query, persona: body.persona });
    return c.json(result);
  });

  app.post("/cache/store", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.semanticCache) return c.json({ error: "feature_disabled" }, 404);
    const body = await c.req
      .json<{ query?: string; persona?: string; answer?: string }>()
      .catch(() => ({} as { query?: string; persona?: string; answer?: string }));
    if (!body.query || !body.persona || !body.answer) return c.json({ error: "missing_fields" }, 400);
    const result = await storeCachedAnswer(c.env, body as any);
    return c.json(result);
  });

  app.post("/route/complete", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.modelRouting) return c.json({ error: "feature_disabled" }, 404);
    const body = await c.req
      .json<{ message?: string; stepIndex?: number }>()
      .catch(() => ({} as { message?: string; stepIndex?: number }));
    if (!body.message) return c.json({ error: "missing_message" }, 400);
    const complexity = estimateComplexity(body.message, body.stepIndex ?? 0);
    const result = await routeComplete(c.env, [{ role: "user", content: body.message }], complexity);
    return c.json(result);
  });

  return app;
}

import { Hono } from "hono";
import { readFeatureFlags, type ExtrasEnv } from "../config";
import { getCompiledPrompt } from "./promptManagement";
import type { LangfuseConfig } from "./client";
import { runOnlineEval, type OnlineEvalEnv } from "./onlineEval";

export interface LangfuseRoutesEnv extends OnlineEvalEnv, ExtrasEnv {}

function cfgFrom(env: LangfuseRoutesEnv): LangfuseConfig | null {
  if (!env.LANGFUSE_BASE_URL || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  return { baseUrl: env.LANGFUSE_BASE_URL, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY };
}

export function buildLangfuseRoutes() {
  const app = new Hono<{ Bindings: LangfuseRoutesEnv }>();

  app.post("/prompts/:name/compile", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.promptMgmt) return c.json({ error: "feature_disabled" }, 404);
    const name = c.req.param("name");
    const body = await c.req
      .json<{ variables?: Record<string, string>; fallback?: string; label?: string }>()
      .catch(() => ({} as { variables?: Record<string, string>; fallback?: string; label?: string }));
    const result = await getCompiledPrompt(cfgFrom(c.env), name, body.variables ?? {}, body.fallback ?? "", { label: body.label });
    return c.json(result);
  });

  app.post("/eval/online", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.onlineEval) return c.json({ error: "feature_disabled" }, 404);
    const body = await c.req
      .json<{ traceId?: string; question?: string; answer?: string; context?: string }>()
      .catch(() => ({} as { traceId?: string; question?: string; answer?: string; context?: string }));
    if (!body.traceId || !body.question || !body.answer) {
      return c.json({ error: "missing_fields" }, 400);
    }
    const result = await runOnlineEval(c.env, { traceId: body.traceId, question: body.question, answer: body.answer, context: body.context ?? "" });
    return c.json(result);
  });

  return app;
}

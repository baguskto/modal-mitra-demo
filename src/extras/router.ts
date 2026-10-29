// Satu titik integrasi untuk SEMUA fitur tambahan — worker inti cukup:
//   import { extrasApp, type ExtrasAppEnv } from "./extras/router";
//   app.route("/api/extras", extrasApp);
// (lalu pastikan Env worker inti mencakup field dari ExtrasAppEnv — lihat README §11 per
// subbagian untuk daftar binding/secret yang dibutuhkan per fitur; fitur yang togglenya OFF tidak
// butuh binding-nya terisi, cek dilakukan di tiap route sebelum binding dipakai).
import { Hono } from "hono";
import { buildVoiceRoutes, type VoiceEnv } from "./voice/routes";
import { buildCacheRoutes, type CacheRoutesEnv } from "./cache/routes";
import { buildSlaRoutes, type WorkflowsRoutesEnv } from "./workflows/routes";
import { buildMemoryRoutes, type MemoryRoutesEnv } from "./memory/routes";
import { buildLangfuseRoutes, type LangfuseRoutesEnv } from "./langfuse/routes";

export type ExtrasAppEnv = VoiceEnv & CacheRoutesEnv & WorkflowsRoutesEnv & MemoryRoutesEnv & LangfuseRoutesEnv;

export const extrasApp = new Hono<{ Bindings: ExtrasAppEnv }>();

extrasApp.route("/", buildVoiceRoutes());
extrasApp.route("/", buildCacheRoutes());
extrasApp.route("/", buildSlaRoutes());
extrasApp.route("/", buildMemoryRoutes());
extrasApp.route("/", buildLangfuseRoutes());

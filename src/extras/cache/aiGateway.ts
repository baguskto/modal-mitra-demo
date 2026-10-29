// Cloudflare AI Gateway — cache/rate-limit/log di layer gateway, provider-agnostic (dipakai untuk
// Workers AI MAUPUN provider eksternal via endpoint "compat"). Trade-off disengaja: fallback
// provider dilakukan di modelRouter.ts (app-level), BUKAN memakai array "fallback" bawaan AI
// Gateway di body request satu endpoint unified — supaya logika cascade (tier 1/2/3 Kenari +
// cadangan Workers AI, lihat modelRouter.ts) tetap satu sumber kebenaran yang mudah dites unit,
// alih-alih terpecah antara kode kita dan konfigurasi JSON gateway yang formatnya bisa berubah.
// Gateway di sini hanya dipakai sebagai "pintu masuk" HTTP opsional per panggilan provider.

export interface AiGatewayEnv {
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
}

export interface GatewayUrlOptions {
  provider: "workers-ai" | "compat";
  path: string; // mis. "@cf/qwen/qwen3-30b-a3b-fp8" atau "chat/completions"
}

export function isGatewayConfigured(env: AiGatewayEnv): boolean {
  return Boolean(env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_ID);
}

/** Bentuk URL AI Gateway Cloudflare: /v1/{account}/{gateway}/{provider}/{path} */
export function buildGatewayUrl(env: AiGatewayEnv, opts: GatewayUrlOptions): string | null {
  if (!isGatewayConfigured(env)) return null;
  return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${opts.provider}/${opts.path}`;
}

/**
 * Header gateway: cache TTL (detik) untuk jawaban yang aman di-cache di layer gateway (selain
 * semantic cache kita sendiri di semanticCache.ts — dua lapis cache dgn tujuan beda: gateway utk
 * request identik persis, semantic cache utk request yang SERUPA secara makna) + metadata tag
 * TANPA PII (session id dipseudonim di pemanggil, bukan di sini) untuk log/observability gateway.
 */
export function gatewayHeaders(opts: { cacheTtlSeconds?: number; metadata?: Record<string, string> } = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.cacheTtlSeconds) headers["cf-aig-cache-ttl"] = String(opts.cacheTtlSeconds);
  if (opts.metadata) headers["cf-aig-metadata"] = JSON.stringify(opts.metadata);
  return headers;
}

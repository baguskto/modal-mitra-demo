// Toggle terpusat untuk semua fitur tambahan (feat/extras). Setiap fitur WAJIB bisa dimatikan
// lewat wrangler var tanpa redeploy kode — default aman (sebagian besar ON untuk demo, tapi
// semantic cache & memori jangka panjang default OFF sampai ada persetujuan/pengujian privasi).

export interface ExtrasEnv {
  FEATURE_VOICE?: string; // "true" | "false"
  FEATURE_LANG_DETECT?: string;
  FEATURE_SEMANTIC_CACHE?: string;
  FEATURE_MODEL_ROUTING?: string;
  FEATURE_AI_GATEWAY?: string;
  FEATURE_SLA_WORKFLOW?: string;
  FEATURE_LONG_TERM_MEMORY?: string;
  FEATURE_PROMPT_MGMT?: string;
  FEATURE_ONLINE_EVAL?: string;

  TTS_MODEL?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  SLA_MINUTES?: string;
}

function flag(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

export function readFeatureFlags(env: ExtrasEnv) {
  return {
    voice: flag(env.FEATURE_VOICE, true),
    langDetect: flag(env.FEATURE_LANG_DETECT, true),
    semanticCache: flag(env.FEATURE_SEMANTIC_CACHE, false),
    modelRouting: flag(env.FEATURE_MODEL_ROUTING, true),
    aiGateway: flag(env.FEATURE_AI_GATEWAY, false),
    slaWorkflow: flag(env.FEATURE_SLA_WORKFLOW, true),
    longTermMemory: flag(env.FEATURE_LONG_TERM_MEMORY, false),
    promptMgmt: flag(env.FEATURE_PROMPT_MGMT, false),
    onlineEval: flag(env.FEATURE_ONLINE_EVAL, false),
  };
}

export type FeatureFlags = ReturnType<typeof readFeatureFlags>;

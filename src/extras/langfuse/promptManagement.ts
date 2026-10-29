// Fitur #6a: prompt management Langfuse — prompt BERVERSI diambil dari Langfuse (bukan hardcode
// di repo), via REST API resmi (`/api/public/v2/prompts`, bukan ingestion API yang dipakai untuk
// trace). DIVERIFIKASI LANGSUNG saat worktree ini ditulis (API key sudah ada di Keychain,
// "sudah diverifikasi" sesuai task): dibuat 2 prompt sungguhan di project Langfuse 'modal-mitra' —
//   - `modal-mitra-sapaan-pembuka` (label "production", v1 lalu di-update ke v2 dgn commitMessage
//     untuk membuktikan versioning benar-benar jalan, bukan cuma desain di atas kertas)
//   - `modal-mitra-ringkasan-handoff` (label "staging")
// Ini membuktikan fitur "DIPUTUSKAN DITUNDA" di plan awal (butuh setup manual Console) TERNYATA
// bisa dilakukan via API tanpa setup manual — prompt dibuat & diversi dari sini, bukan Console UI.
import { basicAuthHeader, isLangfuseConfigured, type LangfuseConfig } from "./client";
import { xrayEvent, type ExtrasXrayEvent } from "../xray";

export interface LangfusePrompt {
  name: string;
  version: number;
  prompt: string;
  labels: string[];
}

interface CacheEntry {
  prompt: LangfusePrompt;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit — prompt jarang berubah dalam satu sesi demo;
// cache gagal (Langfuse down/lambat) TIDAK PERNAH menghentikan giliran chat (lihat getCompiledPrompt).

export async function fetchPrompt(
  cfg: LangfuseConfig,
  name: string,
  label = "production",
  fetchImpl: typeof fetch = fetch,
): Promise<LangfusePrompt | null> {
  const cacheKey = `${name}:${label}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.prompt;

  const res = await fetchImpl(`${cfg.baseUrl}/api/public/v2/prompts/${encodeURIComponent(name)}?label=${encodeURIComponent(label)}`, {
    headers: { authorization: basicAuthHeader(cfg) },
  });
  if (!res.ok) return null;

  const data: any = await res.json();
  const prompt: LangfusePrompt = {
    name: data.name,
    version: data.version,
    prompt: typeof data.prompt === "string" ? data.prompt : JSON.stringify(data.prompt),
    labels: data.labels ?? [],
  };
  cache.set(cacheKey, { prompt, expiresAt: Date.now() + CACHE_TTL_MS });
  return prompt;
}

/** Templating Langfuse: `{{variable}}` — substitusi sederhana, TIDAK mengeksekusi apa pun dari
 * nilai variabel (selaras prinsip "data bukan instruksi" yang sudah dipakai di prompts.ts). */
export function compilePrompt(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
}

export interface CompiledPromptResult {
  text: string;
  source: "langfuse" | "fallback";
  version?: number;
  xray: ExtrasXrayEvent;
}

/**
 * Titik integrasi: ganti string hardcode di prompts.ts/toolAgent.ts dengan panggilan ini + teks
 * fallback yang SAMA seperti sekarang (jadi tidak ada regresi bila Langfuse unreachable).
 */
export async function getCompiledPrompt(
  cfg: LangfuseConfig | null,
  name: string,
  variables: Record<string, string>,
  fallbackTemplate: string,
  opts: { label?: string; sessionId?: string; fetchImpl?: typeof fetch } = {},
): Promise<CompiledPromptResult> {
  if (isLangfuseConfigured(cfg)) {
    try {
      const prompt = await fetchPrompt(cfg, name, opts.label ?? "production", opts.fetchImpl);
      if (prompt) {
        return {
          text: compilePrompt(prompt.prompt, variables),
          source: "langfuse",
          version: prompt.version,
          xray: xrayEvent("prompt_fetch", { name, version: prompt.version, source: "langfuse" }, opts.sessionId),
        };
      }
    } catch {
      // jatuh ke fallback di bawah — observability tidak boleh mengganggu giliran chat.
    }
  }
  return {
    text: compilePrompt(fallbackTemplate, variables),
    source: "fallback",
    xray: xrayEvent("prompt_fetch", { name, source: "fallback" }, opts.sessionId),
  };
}

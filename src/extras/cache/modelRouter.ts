// Fitur #3 (bagian model routing/cascade): model kecil/murah dulu, eskalasi ke model besar bila
// kompleks/confidence rendah — sekarang di atas Kenari (arahan koordinator 2026-10-30, lihat
// kenariProvider.ts) dengan Workers AI sebagai CADANGAN (urutan "Kenari utama, Workers AI
// cadangan" dipertahankan — bukan dibalik — karena pengukuran latensi langsung ke Kenari saat
// worktree ini ditulis TIDAK menunjukkan Kenari lebih lambat dari Workers AI, lihat README §11.3
// untuk angka & keputusannya; "ukur dan putuskan, catat" per arahan koordinator).
import { kenariChatComplete, type ChatMessage, type KenariEnv, type KenariModel } from "./kenariProvider";
import { xrayEvent, type ExtrasXrayEvent } from "../xray";

export type Complexity = "simple" | "moderate" | "complex";

export interface RouterEnv extends KenariEnv {
  AI: Ai;
  MODEL_PRIMARY: string; // fallback Workers AI, mis. "@cf/qwen/qwen3-30b-a3b-fp8"
}

export interface RouteResult {
  text: string;
  provider: "kenari" | "workers-ai";
  model: string;
  tier: 1 | 2 | 3 | "fallback";
  latencyMs: number;
  xray: ExtrasXrayEvent;
}

const CASCADE: { tier: 1 | 2 | 3; model: KenariModel; maxTokens: number }[] = [
  { tier: 1, model: "deepseek-v4-1-flash", maxTokens: 400 },
  { tier: 2, model: "gpt-6-luna", maxTokens: 600 },
  { tier: 3, model: "gpt-6-1-terra", maxTokens: 800 },
];

/**
 * Heuristik kompleksitas murah (tanpa panggilan LLM tambahan) — panjang pesan + sinyal
 * multi-langkah (banyak tanda tanya/klausa) sebagai proxy. confidenceHint opsional datang dari
 * caller (mis. graph node tool-calling yang sudah tahu sedang di langkah ke-N > 1 -> lebih
 * kompleks). Sengaja konservatif: default ke tier sesuai kompleksitas, TIDAK pernah melompat ke
 * tier 3 hanya karena teks panjang tanpa sinyal lain (hemat biaya adalah tujuan fitur ini).
 */
export function estimateComplexity(text: string, stepIndex = 0): Complexity {
  const length = text.length;
  const clauseSignals = (text.match(/[.?!]|dan|atau|karena|tapi|namun/gi) ?? []).length;
  if (stepIndex >= 2 || (length > 220 && clauseSignals >= 4)) return "complex";
  if (stepIndex >= 1 || length > 80 || clauseSignals >= 2) return "moderate";
  return "simple";
}

function startTierFor(complexity: Complexity): 1 | 2 | 3 {
  if (complexity === "complex") return 3;
  if (complexity === "moderate") return 2;
  return 1;
}

export async function routeComplete(
  env: RouterEnv,
  messages: ChatMessage[],
  complexity: Complexity,
  opts: { sessionId?: string; fetchImpl?: typeof fetch } = {},
): Promise<RouteResult> {
  const startTier = startTierFor(complexity);
  const plan = CASCADE.filter((c) => c.tier >= startTier);

  for (const step of plan) {
    try {
      const completion = await kenariChatComplete(env, step.model, messages, step.maxTokens, opts.fetchImpl);
      if (completion.text.trim().length > 0) {
        return {
          text: completion.text,
          provider: "kenari",
          model: step.model,
          tier: step.tier,
          latencyMs: completion.latencyMs,
          xray: xrayEvent(
            "route",
            { provider: "kenari", model: step.model, tier: step.tier, complexity, fallback: false },
            opts.sessionId,
          ),
        };
      }
      // Jawaban kosong dari model kecil dianggap sinyal "confidence rendah" -> eskalasi tier
      // berikutnya di loop ini (bukan langsung fallback provider lain).
    } catch {
      // Error jaringan/model Kenari -> coba tier berikutnya (bila ada), lalu fallback provider.
    }
  }

  // Semua tier Kenari gagal/kosong -> fallback Workers AI (cadangan sesuai arahan koordinator).
  const startedAt = Date.now();
  const prompt = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const result: any = await env.AI.run(env.MODEL_PRIMARY as any, { prompt } as any);
  const text = typeof result === "string" ? result : result?.response ?? result?.text ?? "";
  return {
    text,
    provider: "workers-ai",
    model: env.MODEL_PRIMARY,
    tier: "fallback",
    latencyMs: Date.now() - startedAt,
    xray: xrayEvent(
      "route",
      { provider: "workers-ai", model: env.MODEL_PRIMARY, tier: "fallback", complexity, fallback: true },
      opts.sessionId,
    ),
  };
}

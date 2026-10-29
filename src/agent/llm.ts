// Wrapper panggilan LLM dengan fallback chain multi-provider. Urutan SAAT INI: **Kenari dulu**,
// Workers AI sebagai cadangan — kebalikan dari rencana awal ("Workers AI dulu, cadangan eksternal
// kalau perlu"). Ini keputusan TERUKUR (instruksi Bagus: "ukur dan putuskan, catat"), bukan
// default yang dipilih sembarangan:
//   - Saat migrasi ini dikerjakan, akun Cloudflare Markas Auracheck HABIS kuota gratis Workers AI
//     harian (error 4006) — dicek langsung via wrangler tail, bukan asumsi.
//   - Kenari (kenari.id, OpenAI-compatible, akun Bagus sendiri paket Studio) diuji langsung:
//     gpt-6-1-terra balas JSON bersih ~1-2s tanpa reasoning overhead (deepseek-v4-1-flash yang
//     lebih murah justru menghabiskan ratusan token "reasoning" untuk balasan trivial — pola yang
//     sama dengan temuan Qwen3 thinking-mode di README §Keputusan Desain), endpoint embeddings-nya
//     mengembalikan model "bge-m3" 1024 dimensi — IDENTIK dengan index Vectorize yang sudah ada.
// Begitu kuota Workers AI reset (00:00 UTC / 07:00 WIB) urutan ini LAYAK dibalik lagi (Workers AI
// gratis saat sehat) — lihat src/agent/kenari.ts untuk detail model & README untuk status terkini.
import { kenariChatCompletion } from "./kenari";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallResult {
  text: string;
  modelUsed: string;
  degraded: boolean;
}

const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

export async function callChatModel(
  ai: Ai,
  primaryModel: string,
  messages: ChatMessage[],
  opts: { temperature?: number; max_tokens?: number } = {},
  kenariApiKey?: string,
): Promise<LlmCallResult> {
  const common = { temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 1536 };

  if (kenariApiKey) {
    const text = await kenariChatCompletion(kenariApiKey, messages, common);
    if (text) return { text, modelUsed: "kenari:gpt-6-1-terra", degraded: false };
    console.error("llm_kenari_empty_or_error — jatuh ke Workers AI");
  }

  try {
    const res: any = await ai.run(primaryModel as any, { messages, ...common });
    const text = extractText(res);
    if (text) return { text, modelUsed: primaryModel, degraded: !!kenariApiKey };
    console.error("llm_primary_empty", JSON.stringify(res).slice(0, 500));
    throw new Error("Respons model utama kosong");
  } catch (err: any) {
    console.error("llm_primary_error", primaryModel, err?.message ?? String(err));
    try {
      const res: any = await ai.run(FALLBACK_MODEL as any, { messages, ...common });
      const text = extractText(res);
      if (text) return { text, modelUsed: FALLBACK_MODEL, degraded: true };
      throw new Error("Respons model fallback kosong");
    } catch (err2: any) {
      console.error("llm_fallback_error", err2?.message ?? String(err2));
      return { text: "", modelUsed: "none", degraded: true };
    }
  }
}

function extractText(res: any): string | null {
  if (!res) return null;
  if (typeof res === "string") return res;
  if (typeof res.response === "string" && res.response.length > 0) return res.response;
  // Beberapa model Workers AI (mis. Qwen3) mengembalikan format OpenAI-compatible chat.completions.
  const choiceContent = res?.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string" && choiceContent.length > 0) return choiceContent;
  return null;
}

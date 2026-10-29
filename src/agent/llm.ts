// Wrapper panggilan LLM dengan fallback chain (Workers AI utama -> Workers AI sekunder),
// mirip pola fallback multi-model yang dipakai di AuraCheck untuk menahan timeout/model unavailable.
// OpenRouter TIDAK dipanggil di jalur chat demo ini untuk menghemat kuota $5 OpenRouter
// (lihat README §Keputusan Desain) — binding AI Gateway tetap disiapkan untuk produksi.

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
): Promise<LlmCallResult> {
  const common = { temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 1536 };
  try {
    const res: any = await ai.run(primaryModel as any, { messages, ...common });
    const text = extractText(res);
    if (text) return { text, modelUsed: primaryModel, degraded: false };
    console.error("llm_primary_empty", JSON.stringify(res).slice(0, 500));
    throw new Error("Respons model utama kosong");
  } catch (err: any) {
    console.error("llm_primary_error", primaryModel, err?.message ?? String(err));
    try {
      const res: any = await ai.run(FALLBACK_MODEL as any, { messages, ...common });
      const text = extractText(res);
      return { text: text ?? "", modelUsed: FALLBACK_MODEL, degraded: true };
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

import { detectLanguage, type LanguageDetection } from "./detect";
import { styleInstructionFor } from "./style";
import { xrayEvent, type ExtrasXrayEvent } from "../xray";

export { detectLanguage, styleInstructionFor };
export type { LanguageDetection, DetectedLanguage } from "./detect";

export interface LanguageStyleResult extends LanguageDetection {
  styleInstruction: string;
  xray: ExtrasXrayEvent;
}

/**
 * Titik integrasi tunggal yang disarankan untuk node graph (mis. route_intent di
 * src/agent/graph.ts): panggil SEBELUM buildSystemPrompt, tempelkan `.styleInstruction` ke
 * system prompt, catat `.xray` ke stream X-Ray. Tidak melakukan panggilan LLM/network sama
 * sekali (lihat detect.ts) -> aman dipanggil di setiap giliran tanpa menambah latensi berarti.
 */
export function detectAndStyle(text: string, sessionId?: string): LanguageStyleResult {
  const detection = detectLanguage(text);
  return {
    ...detection,
    styleInstruction: styleInstructionFor(detection.language),
    xray: xrayEvent(
      "lang_detect",
      { language: detection.language, confidence: detection.confidence },
      sessionId,
    ),
  };
}

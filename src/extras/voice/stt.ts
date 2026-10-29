// Fitur #1 (voice note): rekam di UI (MediaRecorder) -> kirim audio -> Whisper (Workers AI) ->
// teks masuk ke alur chat seperti pesan teks biasa. Model Whisper TIDAK melihat identitas sesi,
// hanya audio -> teks mentah (redaksi PII tetap jalan di guard input seperti pesan teks biasa,
// di luar modul ini — modul ini hanya transkripsi).

export interface SttEnv {
  AI: Ai;
}

export interface SttResult {
  text: string;
  wordCount: number;
  durationMs: number;
}

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

/**
 * audio: ArrayBuffer mentah dari rekaman (webm/mp3/wav — Whisper Workers AI menerima array of
 * integers / Uint8Array). Dibatasi ukuran di layer route (lihat voice/routes.ts) untuk
 * mencegah abuse biaya inferensi (least-privilege sederhana, konsisten dgn rate-limit tool lain).
 */
export async function transcribeAudio(env: SttEnv, audio: ArrayBuffer): Promise<SttResult> {
  const startedAt = Date.now();
  const input = { audio: [...new Uint8Array(audio)] };
  const result: any = await env.AI.run(WHISPER_MODEL as any, input as any);
  const text = (result?.text ?? "").trim();
  return {
    text,
    wordCount: text.length === 0 ? 0 : text.split(/\s+/).length,
    durationMs: Date.now() - startedAt,
  };
}

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB, cukup untuk voice note percakapan singkat

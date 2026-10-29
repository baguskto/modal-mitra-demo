// Balasan suara opsional. Workers AI belum punya model TTS yang terverifikasi bagus untuk
// Bahasa Indonesia (katalog model TTS Workers AI saat ini condong Inggris) — daripada menebak
// kualitas, modul ini MENCOBA model yang dikonfigurasi (TTS_MODEL) dan secara eksplisit melaporkan
// `available:false` bila gagal/model tidak ada, sehingga UI jatuh ke Web Speech API browser
// (gratis, mendukung id-ID di Chrome/Edge) — sesuai permintaan brief poin 1 ("bila tidak, Web
// Speech API di browser"). Tidak pernah melempar error ke pemanggil; degradasi selalu graceful.

export interface TtsEnv {
  AI: Ai;
  TTS_MODEL?: string;
}

export interface TtsResult {
  available: boolean;
  audioBase64?: string;
  contentType?: string;
  reason?: string;
}

const DEFAULT_TTS_MODEL = "@cf/myshell-ai/melotts";

export async function synthesizeSpeechIfAvailable(env: TtsEnv, text: string): Promise<TtsResult> {
  if (!text || text.trim().length === 0) {
    return { available: false, reason: "empty_text" };
  }
  const model = env.TTS_MODEL || DEFAULT_TTS_MODEL;
  try {
    const result: any = await env.AI.run(model as any, { prompt: text.slice(0, 500) } as any);
    const bytes: Uint8Array | undefined = result?.audio
      ? Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0))
      : result instanceof ArrayBuffer
        ? new Uint8Array(result)
        : undefined;
    if (!bytes) return { available: false, reason: "model_returned_no_audio" };
    return {
      available: true,
      audioBase64: btoa(String.fromCharCode(...bytes)),
      contentType: "audio/mpeg",
    };
  } catch (err: any) {
    return { available: false, reason: `tts_model_error: ${err?.message ?? "unknown"}` };
  }
}

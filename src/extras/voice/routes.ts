import { Hono } from "hono";
import { MAX_AUDIO_BYTES, transcribeAudio, type SttEnv } from "./stt";
import { synthesizeSpeechIfAvailable, type TtsEnv } from "./tts";
import { readFeatureFlags, type ExtrasEnv } from "../config";
import { xrayEvent } from "../xray";

export type VoiceEnv = SttEnv & TtsEnv & ExtrasEnv;

/**
 * Antarmuka independen dari ChatAgent/graph: worker inti cukup `app.route("/api/extras", extrasApp)`
 * (lihat src/extras/router.ts) lalu, di sisi klien, kirim hasil POST /voice/transcribe sebagai
 * pesan chat biasa (teks) — modul ini TIDAK menyentuh state Durable Object/sesi sama sekali.
 */
export function buildVoiceRoutes() {
  const app = new Hono<{ Bindings: VoiceEnv }>();

  app.post("/voice/transcribe", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.voice) return c.json({ error: "feature_disabled" }, 404);

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_AUDIO_BYTES) {
      return c.json({ error: "audio_too_large", maxBytes: MAX_AUDIO_BYTES }, 413);
    }

    const audio = await c.req.arrayBuffer();
    if (audio.byteLength === 0) return c.json({ error: "empty_audio" }, 400);
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      return c.json({ error: "audio_too_large", maxBytes: MAX_AUDIO_BYTES }, 413);
    }

    const sttResult = await transcribeAudio(c.env, audio);
    const event = xrayEvent("stt", {
      wordCount: sttResult.wordCount,
      durationMs: sttResult.durationMs,
      audioBytes: audio.byteLength,
    });
    return c.json({ text: sttResult.text, xray: event });
  });

  app.post("/voice/speak", async (c) => {
    const flags = readFeatureFlags(c.env);
    if (!flags.voice) return c.json({ error: "feature_disabled" }, 404);

    const body = await c.req.json<{ text?: string }>().catch(() => ({ text: "" }));
    const text = (body.text ?? "").trim();
    if (!text) return c.json({ error: "missing_text" }, 400);

    const tts = await synthesizeSpeechIfAvailable(c.env, text);
    const event = xrayEvent("tts", { available: tts.available, reason: tts.reason ?? null });
    return c.json({ ...tts, xray: event });
  });

  return app;
}

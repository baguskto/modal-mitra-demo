import { describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "../../src/extras/voice/stt";
import { synthesizeSpeechIfAvailable } from "../../src/extras/voice/tts";
import { buildVoiceRoutes } from "../../src/extras/voice/routes";

function fakeEnv(aiRun: (model: string, input: any) => Promise<any>) {
  return { AI: { run: aiRun } } as any;
}

describe("voice/stt", () => {
  it("transcribes audio and reports word count", async () => {
    const env = fakeEnv(async () => ({ text: "halo saya mau tanya angsuran" }));
    const result = await transcribeAudio(env, new ArrayBuffer(8));
    expect(result.text).toBe("halo saya mau tanya angsuran");
    expect(result.wordCount).toBe(5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns empty text with zero word count when model returns nothing", async () => {
    const env = fakeEnv(async () => ({ text: "" }));
    const result = await transcribeAudio(env, new ArrayBuffer(4));
    expect(result.text).toBe("");
    expect(result.wordCount).toBe(0);
  });
});

describe("voice/tts", () => {
  it("degrades gracefully when the model throws (e.g. unsupported language)", async () => {
    const env = fakeEnv(async () => {
      throw new Error("model not found");
    });
    const result = await synthesizeSpeechIfAvailable(env as any, "halo");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("tts_model_error");
  });

  it("returns audio when model responds with base64 audio", async () => {
    const env = fakeEnv(async () => ({ audio: btoa("fake-audio-bytes") }));
    const result = await synthesizeSpeechIfAvailable(env as any, "halo dunia");
    expect(result.available).toBe(true);
    expect(result.audioBase64).toBeTruthy();
  });

  it("reports empty_text without calling the model", async () => {
    const run = vi.fn();
    const result = await synthesizeSpeechIfAvailable(fakeEnv(run) as any, "   ");
    expect(result).toEqual({ available: false, reason: "empty_text" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("voice routes", () => {
  it("rejects when FEATURE_VOICE is disabled", async () => {
    const app = buildVoiceRoutes();
    const res = await app.request("/voice/transcribe", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    }, { FEATURE_VOICE: "false", AI: { run: vi.fn() } } as any);
    expect(res.status).toBe(404);
  });

  it("transcribes via the route and attaches an stt xray event", async () => {
    const app = buildVoiceRoutes();
    const env = { FEATURE_VOICE: "true", AI: { run: async () => ({ text: "cek angsuran saya" }) } } as any;
    const res = await app.request("/voice/transcribe", {
      method: "POST",
      body: new Uint8Array([1, 2, 3, 4]),
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("cek angsuran saya");
    expect(body.xray.type).toBe("stt");
  });

  it("rejects empty audio", async () => {
    const app = buildVoiceRoutes();
    const env = { FEATURE_VOICE: "true", AI: { run: vi.fn() } } as any;
    const res = await app.request("/voice/transcribe", { method: "POST", body: new Uint8Array([]) }, env);
    expect(res.status).toBe(400);
  });
});

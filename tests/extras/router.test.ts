import { describe, expect, it, vi } from "vitest";
import { extrasApp } from "../../src/extras/router";

// Smoke test for the single integration point promised in README §11 — `extrasApp` must actually
// dispatch to each sub-module once mounted, not just type-check.
describe("extras/router combined extrasApp", () => {
  function fakeEnv() {
    return {
      FEATURE_VOICE: "true",
      FEATURE_SEMANTIC_CACHE: "false",
      FEATURE_MODEL_ROUTING: "false",
      FEATURE_SLA_WORKFLOW: "false",
      FEATURE_LONG_TERM_MEMORY: "false",
      FEATURE_PROMPT_MGMT: "false",
      FEATURE_ONLINE_EVAL: "false",
      AI: { run: vi.fn(async () => ({ text: "halo dari extrasApp" })) },
    } as any;
  }

  it("routes /voice/transcribe through to the voice module", async () => {
    const res = await extrasApp.request("/voice/transcribe", { method: "POST", body: new Uint8Array([1, 2, 3]) }, fakeEnv());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("halo dari extrasApp");
  });

  it("routes a feature-disabled endpoint (cache) to a 404, not a crash", async () => {
    const res = await extrasApp.request(
      "/cache/lookup",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "x", persona: "mitra" }) },
      fakeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (not 500) for an unknown path", async () => {
    const res = await extrasApp.request("/does-not-exist", {}, fakeEnv());
    expect(res.status).toBe(404);
  });
});

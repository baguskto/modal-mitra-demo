import { describe, expect, it, vi, beforeEach } from "vitest";
import { compilePrompt, fetchPrompt, getCompiledPrompt } from "../../src/extras/langfuse/promptManagement";
import { shouldSample, judgeTurn, postScoreToLangfuse, runOnlineEval } from "../../src/extras/langfuse/onlineEval";
import { basicAuthHeader, isLangfuseConfigured } from "../../src/extras/langfuse/client";
import { buildLangfuseRoutes } from "../../src/extras/langfuse/routes";

const CFG = { baseUrl: "https://jp.cloud.langfuse.com", publicKey: "pk-test", secretKey: "sk-test" };

describe("langfuse/client", () => {
  it("reports configured only when all three fields are present", () => {
    expect(isLangfuseConfigured(CFG)).toBe(true);
    expect(isLangfuseConfigured({ baseUrl: "x" })).toBe(false);
    expect(isLangfuseConfigured(null)).toBe(false);
  });

  it("builds a valid base64 basic-auth header", () => {
    const header = basicAuthHeader(CFG);
    expect(header.startsWith("Basic ")).toBe(true);
    expect(atob(header.slice(6))).toBe("pk-test:sk-test");
  });
});

describe("langfuse/promptManagement compilePrompt", () => {
  it("substitutes {{variable}} placeholders", () => {
    expect(compilePrompt("Halo {{nama}}, status: {{status}}", { nama: "Sri", status: "lunas" })).toBe("Halo Sri, status: lunas");
  });
  it("leaves unknown placeholders untouched rather than injecting empty/undefined", () => {
    expect(compilePrompt("Halo {{nama}}", {})).toBe("Halo {{nama}}");
  });
});

describe("langfuse/promptManagement fetchPrompt + getCompiledPrompt", () => {
  it("fetches and compiles a real-shaped Langfuse prompt response", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/api/public/v2/prompts/modal-mitra-sapaan-pembuka");
      expect(url).toContain("label=production");
      return new Response(JSON.stringify({ name: "modal-mitra-sapaan-pembuka", version: 2, prompt: "Halo {{nama}}, ada yang bisa dibantu?", labels: ["production", "latest"] }), { status: 200 });
    });
    const prompt = await fetchPrompt(CFG, "modal-mitra-sapaan-pembuka", "production", fetchMock as any);
    expect(prompt?.version).toBe(2);
    expect(prompt?.prompt).toContain("{{nama}}");
  });

  it("getCompiledPrompt falls back to the local template when Langfuse is not configured", async () => {
    const result = await getCompiledPrompt(null, "x", { nama: "Budi" }, "Halo {{nama}} (fallback)");
    expect(result.source).toBe("fallback");
    expect(result.text).toBe("Halo Budi (fallback)");
  });

  it("getCompiledPrompt falls back gracefully when the Langfuse fetch throws", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("network down"); });
    const result = await getCompiledPrompt(CFG, "x", { nama: "Budi" }, "Halo {{nama}} (fallback)", { fetchImpl: fetchMock as any });
    expect(result.source).toBe("fallback");
  });

  it("getCompiledPrompt uses the Langfuse version when the fetch succeeds", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "x", version: 3, prompt: "Halo {{nama}} (langfuse)", labels: [] }), { status: 200 }));
    const result = await getCompiledPrompt(CFG, "modal-mitra-sapaan-pembuka-unique-1", { nama: "Budi" }, "fallback", { fetchImpl: fetchMock as any });
    expect(result.source).toBe("langfuse");
    expect(result.version).toBe(3);
    expect(result.text).toBe("Halo Budi (langfuse)");
  });
});

describe("langfuse/onlineEval", () => {
  it("shouldSample respects the injected RNG deterministically", () => {
    expect(shouldSample(() => 0.01)).toBe(true);
    expect(shouldSample(() => 0.99)).toBe(false);
  });

  it("judgeTurn parses a well-formed JSON verdict from the judge model", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"groundedScore":0.9,"politeScore":1,"reason":"grounded dan sopan"}' } }], usage: {} }), { status: 200 }));
    const verdict = await judgeTurn({ KENARI_API_KEY: "k" }, { question: "q", answer: "a", context: "c" }, fetchMock as any);
    expect(verdict?.groundedScore).toBe(0.9);
    expect(verdict?.politeScore).toBe(1);
  });

  it("judgeTurn returns null on unparseable judge output instead of throwing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "bukan json sama sekali" } }], usage: {} }), { status: 200 }));
    const verdict = await judgeTurn({ KENARI_API_KEY: "k" }, { question: "q", answer: "a", context: "c" }, fetchMock as any);
    expect(verdict).toBeNull();
  });

  it("postScoreToLangfuse reports sent:false when not configured, without throwing", async () => {
    const result = await postScoreToLangfuse(null, { traceId: "t1", name: "online_grounded", value: 1 });
    expect(result.sent).toBe(false);
  });

  it("postScoreToLangfuse sends a score-create ingestion event when configured", async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      expect(url).toContain("/api/public/ingestion");
      const body = JSON.parse(init.body);
      expect(body.batch[0].type).toBe("score-create");
      expect(body.batch[0].body.traceId).toBe("t1");
      return new Response("ok", { status: 207 });
    });
    const result = await postScoreToLangfuse(CFG, { traceId: "t1", name: "online_grounded", value: 0.8 }, fetchMock as any);
    expect(result.sent).toBe(true);
  });

  it("runOnlineEval skips the judge entirely when not sampled", async () => {
    const result = await runOnlineEval(
      { KENARI_API_KEY: "k" },
      { traceId: "t1", question: "q", answer: "a", context: "c" },
      () => 0.99, // > sample rate -> skip
    );
    expect(result.sampled).toBe(false);
    expect(result.verdict).toBeNull();
  });
});

describe("langfuse routes", () => {
  it("returns 404 for prompt compile when FEATURE_PROMPT_MGMT is disabled", async () => {
    const app = buildLangfuseRoutes();
    const res = await app.request("/prompts/x/compile", { method: "POST", body: "{}" }, { FEATURE_PROMPT_MGMT: "false" } as any);
    expect(res.status).toBe(404);
  });

  it("returns 404 for online eval when FEATURE_ONLINE_EVAL is disabled", async () => {
    const app = buildLangfuseRoutes();
    const res = await app.request("/eval/online", { method: "POST", body: "{}" }, { FEATURE_ONLINE_EVAL: "false" } as any);
    expect(res.status).toBe(404);
  });

  it("compiles a prompt via the route using the local fallback (no Langfuse config)", async () => {
    const app = buildLangfuseRoutes();
    const res = await app.request(
      "/prompts/x/compile",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variables: { nama: "Sri" }, fallback: "Halo {{nama}}" }) },
      { FEATURE_PROMPT_MGMT: "true" } as any,
    );
    const body = await res.json();
    expect(body.source).toBe("fallback");
    expect(body.text).toBe("Halo Sri");
  });
});

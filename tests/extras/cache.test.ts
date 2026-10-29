import { describe, expect, it, vi } from "vitest";
import {
  kenariChatComplete,
  KenariModelNotAllowedError,
} from "../../src/extras/cache/kenariProvider";
import { routeComplete, estimateComplexity } from "../../src/extras/cache/modelRouter";
import { getCachedAnswer, storeCachedAnswer } from "../../src/extras/cache/semanticCache";
import { buildGatewayUrl, gatewayHeaders, isGatewayConfigured } from "../../src/extras/cache/aiGateway";

describe("cache/kenariProvider", () => {
  it("rejects a model outside the Studio-plan allowlist (e.g. gpt-6-astra)", async () => {
    await expect(
      kenariChatComplete({ KENARI_API_KEY: "k" }, "gpt-6-astra" as any, [], 100),
    ).rejects.toBeInstanceOf(KenariModelNotAllowedError);
  });

  it("calls the OpenAI-compatible endpoint with max_tokens always set", async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.max_tokens).toBe(250);
      expect(body.model).toBe("deepseek-v4-1-flash");
      expect(init.headers.authorization).toBe("Bearer secret-key");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "halo!" } }], usage: { total_tokens: 12 } }),
        { status: 200 },
      );
    });
    const result = await kenariChatComplete(
      { KENARI_API_KEY: "secret-key" },
      "deepseek-v4-1-flash",
      [{ role: "user", content: "hai" }],
      250,
      fetchMock as any,
    );
    expect(result.text).toBe("halo!");
    expect(result.totalTokens).toBe(12);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws a clear error on non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    await expect(
      kenariChatComplete({ KENARI_API_KEY: "k" }, "gpt-6-luna", [], 100, fetchMock as any),
    ).rejects.toThrow(/Kenari HTTP 429/);
  });
});

describe("cache/modelRouter estimateComplexity", () => {
  it("classifies a short greeting as simple", () => {
    expect(estimateComplexity("halo")).toBe("simple");
  });
  it("classifies a long multi-clause question as complex", () => {
    const text = "Saya mau tanya karena bulan ini saya telat bayar dan ingin tahu apakah bisa restrukturisasi, tapi juga ingin tahu dampaknya ke skor kelompok karena takut memberatkan anggota lain, dan juga ingin tahu apakah ini akan dilaporkan ke OJK atau tidak, karena saya khawatir.";
    expect(estimateComplexity(text)).toBe("complex");
  });
  it("treats a later agent step as at least moderate even for short text", () => {
    expect(estimateComplexity("ok", 1)).toBe("moderate");
  });
});

describe("cache/modelRouter routeComplete", () => {
  function fakeEnv(workersAiRun: any = vi.fn()) {
    return { KENARI_API_KEY: "k", AI: { run: workersAiRun }, MODEL_PRIMARY: "@cf/qwen/qwen3-30b-a3b-fp8" };
  }

  it("answers from tier 1 (deepseek) for a simple query without escalating", async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe("deepseek-v4-1-flash");
      return new Response(JSON.stringify({ choices: [{ message: { content: "jawaban singkat" } }], usage: {} }), { status: 200 });
    });
    const result = await routeComplete(fakeEnv(), [{ role: "user", content: "halo" }], "simple", { fetchImpl: fetchMock as any });
    expect(result.provider).toBe("kenari");
    expect(result.model).toBe("deepseek-v4-1-flash");
    expect(result.tier).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("starts at tier 3 (gpt-6-1-terra) directly for complex queries", async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe("gpt-6-1-terra");
      return new Response(JSON.stringify({ choices: [{ message: { content: "jawaban kompleks" } }], usage: {} }), { status: 200 });
    });
    const result = await routeComplete(fakeEnv(), [{ role: "user", content: "..." }], "complex", { fetchImpl: fetchMock as any });
    expect(result.model).toBe("gpt-6-1-terra");
    expect(result.tier).toBe(3);
  });

  it("falls back to Workers AI when every Kenari tier fails", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 500 }));
    const workersAiRun = vi.fn(async () => ({ response: "jawaban dari workers ai" }));
    const result = await routeComplete(fakeEnv(workersAiRun), [{ role: "user", content: "halo" }], "simple", { fetchImpl: fetchMock as any });
    expect(result.provider).toBe("workers-ai");
    expect(result.tier).toBe("fallback");
    expect(result.text).toBe("jawaban dari workers ai");
    expect(result.xray.data.fallback).toBe(true);
  });
});

describe("cache/semanticCache", () => {
  function fakeEnv(opts: { matches?: any[]; upsertSpy?: ReturnType<typeof vi.fn> } = {}) {
    const upsert = opts.upsertSpy ?? vi.fn(async () => ({}));
    return {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      CACHE_VECTORIZE: {
        query: vi.fn(async () => ({ matches: opts.matches ?? [] })),
        upsert,
      },
      EMBED_MODEL: "@cf/baai/bge-m3",
    } as any;
  }

  it("reports a cache miss when nothing matches above the similarity threshold", async () => {
    const env = fakeEnv({ matches: [{ score: 0.5, metadata: {} }] });
    const { hit, xray } = await getCachedAnswer(env, { query: "biaya jasa berapa", persona: "mitra" });
    expect(hit).toBeNull();
    expect(xray.type).toBe("cache_miss");
  });

  it("returns a hit for a high-similarity, non-expired, same-persona match", async () => {
    const env = fakeEnv({
      matches: [
        {
          score: 0.97,
          metadata: { persona: "mitra", answer: "Biaya jasa 1% per bulan.", expiresAt: Date.now() + 100000, cachedAt: "x" },
        },
      ],
    });
    const { hit, xray } = await getCachedAnswer(env, { query: "biaya jasanya berapa ya", persona: "mitra" });
    expect(hit?.answer).toBe("Biaya jasa 1% per bulan.");
    expect(xray.type).toBe("cache_hit");
  });

  it("does not leak a cache hit across personas", async () => {
    const env = fakeEnv({
      matches: [{ score: 0.99, metadata: { persona: "pendana", answer: "jawaban pendana", expiresAt: Date.now() + 100000 } }],
    });
    const { hit } = await getCachedAnswer(env, { query: "sama-sama", persona: "mitra" });
    expect(hit).toBeNull();
  });

  it("ignores an expired cache entry", async () => {
    const env = fakeEnv({
      matches: [{ score: 0.99, metadata: { persona: "mitra", answer: "kadaluarsa", expiresAt: Date.now() - 1000 } }],
    });
    const { hit } = await getCachedAnswer(env, { query: "x", persona: "mitra" });
    expect(hit).toBeNull();
  });

  it("refuses to store an answer that still contains raw PII (hard safety net)", async () => {
    const upsertSpy = vi.fn(async () => ({}));
    const env = fakeEnv({ upsertSpy });
    const result = await storeCachedAnswer(env, {
      query: "berapa hp cs kalian",
      persona: "mitra",
      answer: "Hubungi kami di 081234567890 ya.",
    });
    expect(result.stored).toBe(false);
    expect(result.reason).toContain("PII");
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("stores a clean FAQ answer with persona + expiry metadata", async () => {
    const upsertSpy = vi.fn(async () => ({}));
    const env = fakeEnv({ upsertSpy });
    const result = await storeCachedAnswer(env, {
      query: "berapa biaya jasa",
      persona: "mitra",
      answer: "Biaya jasa pinjaman modal usaha mikro adalah 1% per bulan [produk#1].",
    });
    expect(result.stored).toBe(true);
    expect(upsertSpy).toHaveBeenCalledOnce();
    const [[entry]] = upsertSpy.mock.calls;
    expect(entry[0].metadata.persona).toBe("mitra");
    expect(entry[0].metadata.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("cache/aiGateway", () => {
  it("reports not configured when ids are missing", () => {
    expect(isGatewayConfigured({})).toBe(false);
    expect(buildGatewayUrl({}, { provider: "workers-ai", path: "@cf/model" })).toBeNull();
  });

  it("builds a well-formed gateway URL when configured", () => {
    const env = { AI_GATEWAY_ACCOUNT_ID: "acc123", AI_GATEWAY_ID: "gw1" };
    expect(buildGatewayUrl(env, { provider: "compat", path: "chat/completions" })).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc123/gw1/compat/chat/completions",
    );
  });

  it("builds cache-ttl and metadata headers without leaking raw session ids as PII", () => {
    const headers = gatewayHeaders({ cacheTtlSeconds: 3600, metadata: { persona: "mitra" } });
    expect(headers["cf-aig-cache-ttl"]).toBe("3600");
    expect(JSON.parse(headers["cf-aig-metadata"])).toEqual({ persona: "mitra" });
  });
});

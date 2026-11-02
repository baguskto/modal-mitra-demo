import { describe, it, expect, vi, afterEach } from "vitest";
import { createD1 } from "../../scripts/harness/d1shim";
import { WorkersAiBudget, meteredAi, estimateNeurons, RACE_CAP, HARD_CAP } from "../../src/agent/aiBudget";
import { streamChatModel } from "../../src/agent/llm";

const QWEN = "@cf/qwen/qwen3-30b-a3b-fp8";

describe("anggaran neuron Workers AI harian (cap biaya nol)", () => {
  it("perkiraan neuron giliran Qwen biasa kecil (~puluhan), jadi 8.000 = ratusan giliran", () => {
    const n = estimateNeurons(QWEN, 6000, 600); // ~1.500 token input + 150 token output
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(20);
  });

  it("akumulasi lintas giliran tersimpan di D1 (UPSERT) dan dibaca giliran berikutnya", async () => {
    const db = createD1();
    const b1 = new WorkersAiBudget(db, "2026-11-02");
    await b1.load();
    b1.record(QWEN, 400_000, 0); // ~1.850 neuron
    await b1.flush();
    const b2 = new WorkersAiBudget(db, "2026-11-02");
    expect(await b2.load()).toBeCloseTo(estimateNeurons(QWEN, 400_000, 0), 3);
    // Hari UTC lain -> mulai dari nol.
    expect(await new WorkersAiBudget(db, "2026-11-03").load()).toBe(0);
  });

  it(`>= ${RACE_CAP} neuron: balapan opsional (Qwen) DITOLAK, Llama Guard/embedding masih boleh; >= ${HARD_CAP}: semua ditolak`, async () => {
    const db = createD1();
    await db.prepare("CREATE TABLE IF NOT EXISTS workers_ai_budget (day TEXT PRIMARY KEY, neurons REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    await db.prepare("INSERT INTO workers_ai_budget (day, neurons) VALUES (?, ?)").bind("2026-11-02", RACE_CAP + 1).run();
    const budget = new WorkersAiBudget(db, "2026-11-02");
    await budget.load();
    const raw = { run: vi.fn().mockResolvedValue({ response: "safe" }) } as any;
    const ai = meteredAi(raw, budget, new Set([QWEN]));
    await expect(ai.run(QWEN as any, { messages: [{ role: "user", content: "hi" }] } as any)).rejects.toThrow(/workers_ai_budget_cap/);
    await expect(ai.run("@cf/meta/llama-guard-3-8b" as any, { messages: [{ role: "user", content: "hi" }] } as any)).resolves.toEqual({ response: "safe" });
    expect(raw.run).toHaveBeenCalledTimes(1); // Qwen tidak pernah sampai ke binding asli

    budget.record("@cf/meta/llama-guard-3-8b", 4 * 1_000_000, 0); // dorong melewati HARD_CAP
    expect(budget.allowAny()).toBe(false);
    await expect(ai.run("@cf/meta/llama-guard-3-8b" as any, { messages: [] } as any)).rejects.toThrow(/workers_ai_budget_cap/);
  });

  it("gagal baca D1 -> FAIL-CLOSED (dianggap sudah HARD_CAP, tidak ada panggilan Workers AI)", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as any;
    const b = new WorkersAiBudget(broken, "2026-11-02");
    await b.load();
    expect(b.allowRace()).toBe(false);
    expect(b.allowAny()).toBe(false);
  });

  it("output stream yang dibatalkan (kalah balapan) tetap tercatat per potongan", async () => {
    const db = createD1();
    const budget = new WorkersAiBudget(db, "2026-11-02");
    await budget.load();
    const enc = new TextEncoder();
    const raw = {
      run: vi.fn().mockResolvedValue(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: {"response":"${"x".repeat(4000)}"}\n\n`));
          },
        }),
      ),
    } as any;
    const ai = meteredAi(raw, budget, new Set([QWEN]));
    const before = budget.used;
    const s: ReadableStream = (await ai.run(QWEN as any, { messages: [{ role: "user", content: "a" }] } as any)) as any;
    const reader = s.getReader();
    await reader.read();
    await reader.cancel();
    expect(budget.used - before).toBeGreaterThan(estimateNeurons(QWEN, 4, 0));
  });
});

describe("balapan jawaban mematuhi cap", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("workersAfterMs < 0 (cap tercapai) -> Workers AI tidak pernah dipanggil, Kenari tetap menjawab", async () => {
    const enc = new TextEncoder();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Halo Bu." } }] })}\n\ndata: [DONE]\n\n`));
            c.close();
          },
        }),
      ),
    ) as any;
    const ai = { run: vi.fn() } as any;
    const out: string[] = [];
    const r = await streamChatModel(ai, QWEN, [{ role: "user", content: "hi" }], (d) => void out.push(d), { kenariApiKey: "k", workersAfterMs: -1 });
    expect(out.join("")).toBe("Halo Bu.");
    expect(ai.run).not.toHaveBeenCalled();
    expect(r.candidates?.some((c) => c.startsWith("workers_ai"))).toBe(false);
  });

  it("balapan sejak 0 ms: Workers AI lebih cepat menang, stream Kenari dibatalkan (abort)", async () => {
    let kenariSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_u: string, init: any) => {
      kenariSignal = init.signal;
      await new Promise((r) => setTimeout(r, 300));
      throw new Error("aborted");
    }) as any;
    const enc = new TextEncoder();
    const ai = {
      run: vi.fn().mockResolvedValue(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: {"response":"Baik Bu."}\n\n`));
            c.close();
          },
        }),
      ),
    } as any;
    const out: string[] = [];
    const r = await streamChatModel(ai, QWEN, [{ role: "user", content: "hi" }], (d) => void out.push(d), { kenariApiKey: "k", workersAfterMs: 0 });
    expect(out.join("")).toBe("Baik Bu.");
    expect(r.modelUsed).toBe(QWEN);
    expect(kenariSignal?.aborted).toBe(true);
  });
});

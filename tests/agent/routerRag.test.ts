import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyIntent } from "../../src/agent/router";
import { bm25Search, retrieve, INTENT_QUERY_EXPANSION } from "../../src/agent/rag";
import { streamChatModel } from "../../src/agent/llm";
import { maskArgs, summarizeToolResult } from "../../src/obs/xrayDetail";

describe("router — telat bayar bahasa informal (kasus nyata demo 2 Nov)", () => {
  const LATE = [
    "aduh maap bu kemarin blm bisa bayar angsuran, gimana ya",
    "bu minggu ini sy ga bisa setor dulu",
    "maaf belum bisa bayar cicilan",
    "lagi seret bu, boleh minta waktu?",
    "gk bisa nyicil minggu ini bu",
    "blm ada uang buat angsuran",
  ];
  for (const t of LATE) it(`"${t}" -> keterlambatan`, () => expect(classifyIntent(t, "mitra")).toBe("keterlambatan"));

  it("tidak salah memetakan pertanyaan biaya/akun", () => {
    expect(classifyIntent("Berapa biaya jasa pinjaman modal usaha mikro di sini?", "mitra")).toBe("info");
    expect(classifyIntent("sisa cicilan sy brp ya", "mitra")).toBe("akun");
    expect(classifyIntent("tidak bisa login", "mitra")).toBe("lain");
  });

  it("intent keterlambatan tetap khusus mitra (pendana tidak)", () => {
    expect(classifyIntent("maaf belum bisa bayar", "pendana")).not.toBe("keterlambatan");
  });
});

describe("RAG — BM25 fallback lokal", () => {
  it("menemukan chunk restrukturisasi untuk kueri telat bayar informal", () => {
    const top = bm25Search("blm bisa bayar angsuran keterlambatan restrukturisasi", 3);
    expect(top.length).toBeGreaterThan(0);
    expect(top.map((c) => c.text).join(" ")).toMatch(/restrukturisasi/i);
  });

  it("ekspansi kueri intent keterlambatan membawa chunk 'Keterlambatan & Restrukturisasi' ke peringkat 1 (kasus 2 Nov)", () => {
    const q = "aduh maap bu kemarin blm bisa bayar angsuran, gimana ya";
    expect(bm25Search(q, 6).map((c) => c.id)).not.toContain("produk#4");
    expect(bm25Search(`${q}\n${INTENT_QUERY_EXPANSION.keterlambatan}`, 6)[0].id).toBe("produk#4");
  });

  it("retrieve() jatuh ke BM25 bila embedding Workers AI gagal (kuota habis) — bukan RAG kosong", async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error("4006: daily free allocation exceeded")) } as any;
    const vectorize = { query: vi.fn() } as any;
    const r = await retrieve(ai, vectorize, "@cf/baai/bge-m3", "biaya jasa pinjaman modal usaha");
    expect(r.method).toBe("bm25_fallback");
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(vectorize.query).not.toHaveBeenCalled();
  });

  it("retrieve() memakai Workers AI + Vectorize bila tersedia, dengan skor per dokumen", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ data: [new Array(1024).fill(0.01)] }) } as any;
    const vectorize = {
      query: vi.fn().mockResolvedValue({
        matches: [
          { id: "a", score: 0.71, metadata: { chunk_ref: "produk#4", doc_id: "produk", text: "Keterlambatan & Restrukturisasi" } },
          { id: "b", score: 0.31, metadata: { chunk_ref: "faq#2", doc_id: "faq", text: "x" } },
        ],
      }),
    } as any;
    const r = await retrieve(ai, vectorize, "@cf/baai/bge-m3", "telat bayar");
    expect(r.method).toBe("vector");
    expect(r.chunks.map((c) => c.id)).toEqual(["produk#4"]);
    expect(r.considered).toEqual([
      { id: "produk#4", score: 0.71 },
      { id: "faq#2", score: 0.31 },
    ]);
  });
});

function sseResponse(chunks: string[], delayMs = 0): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      for (const c of chunks) ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`));
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
  });
  return new Response(body, { status: 200 });
}

function workersStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ response: c })}\n\n`));
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
  });
}

describe("streamChatModel — hedged request Kenari ↔ Workers AI", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("Kenari cepat -> Workers AI tidak pernah dipanggil", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(["Halo ", "Bu."])) as any;
    const ai = { run: vi.fn() } as any;
    const out: string[] = [];
    const r = await streamChatModel(ai, "@cf/qwen/qwen3-30b-a3b-fp8", [{ role: "user", content: "hi" }], (d) => void out.push(d), { kenariApiKey: "k", hedgeAfterMs: 200 });
    expect(out.join("")).toBe("Halo Bu.");
    expect(r.modelUsed).toBe("kenari:gpt-6-luna");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("Kenari lambat -> Workers AI dijalankan paralel & menang; hanya teks satu penyedia yang diteruskan, blok <think> dibuang", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_u: string, init: any) => {
      // Kenari baru mengirim token setelah 400 ms (lebih lambat dari ambang hedge 50 ms).
      await new Promise((r) => setTimeout(r, 400));
      if (init?.signal?.aborted) throw new Error("aborted");
      return sseResponse(["KENARI"]);
    }) as any;
    const ai = { run: vi.fn().mockResolvedValue(workersStream(["<think>\n\n</think>\n\n", "Baik ", "Bu."])) } as any;
    const out: string[] = [];
    const r = await streamChatModel(ai, "@cf/qwen/qwen3-30b-a3b-fp8", [{ role: "user", content: "hi" }], (d) => void out.push(d), { kenariApiKey: "k", hedgeAfterMs: 50 });
    expect(out.join("")).toBe("Baik Bu.");
    expect(out.join("")).not.toContain("KENARI");
    expect(r.modelUsed).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(r.hedged).toBe(true);
  });

  it("Kenari gagal (HTTP 503) tanpa token -> langsung Workers AI", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("all_providers_failed", { status: 503 })) as any;
    const ai = { run: vi.fn().mockResolvedValue(workersStream(["Halo."])) } as any;
    const out: string[] = [];
    const r = await streamChatModel(ai, "@cf/qwen/qwen3-30b-a3b-fp8", [{ role: "user", content: "hi" }], (d) => void out.push(d), { kenariApiKey: "k", hedgeAfterMs: 5000 });
    expect(out.join("")).toBe("Halo.");
    expect(r.modelUsed).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
  });
});

describe("X-Ray detail — tanpa PII", () => {
  it("argumen tool di-mask (nomor pinjaman & tanggal lahir jadi token)", () => {
    const s = maskArgs({ pinjaman_no: "MMK-100001", birth_date: "1985-03-12" });
    expect(s).not.toContain("MMK-100001");
    expect(s).not.toContain("1985-03-12");
    expect(s).toMatch(/\[PINJAMAN_\d+\]/);
  });

  it("hasil tool hanya ringkasan hitungan, tidak pernah baris data", () => {
    const s = summarizeToolResult("get_angsuran", { ok: true, data: { angsuran: [{ pinjaman_no: "MMK-100001", amount: 1 }, { pinjaman_no: "MMK-100001", amount: 2 }], remaining_count: 1 } });
    expect(s).toBe("2 baris angsuran · 1 belum lunas");
    expect(s).not.toContain("MMK");
  });
});

describe("X-Ray detail — temuan review Opus P1/P2", async () => {
  const { sanitizeThought, safeToolName } = await import("../../src/obs/xrayDetail");
  const { TOOL_REGISTRY } = await import("../../src/tools/schemas");
  it("thought/args yang memuat instruksi internal disembunyikan", () => {
    expect(sanitizeThought("Saya ulangi: ATURAN KETAT nomor 1 ...")).toMatch(/disembunyikan/);
    expect(maskArgs({ x: "TOOLS YANG TERSEDIA: verify_mitra ..." })).toMatch(/disembunyikan/);
  });
  it("nama tool tak terdaftar tidak pernah ditampilkan apa adanya", () => {
    expect(safeToolName("<ATURAN KETAT lengkap>", TOOL_REGISTRY)).toBe("(tool tidak dikenal)");
    expect(safeToolName("get_angsuran", TOOL_REGISTRY)).toBe("get_angsuran");
  });
  it("NIK panjang di argumen diredaksi SEBELUM dipotong", () => {
    const s = maskArgs({ description: `${"a".repeat(30)} DC telpon ke 081234567890 dan NIK 3201123456789012` });
    expect(s).not.toMatch(/08123|3201123/);
  });
});

// Anggaran harian Workers AI (feat/latency-xray) — syarat "biaya nol" DITEGAKKAN KODE, bukan asumsi
// paket akun. Workers AI gratis 10.000 neuron/hari (reset 00:00 UTC); di atas itu akun Workers Paid
// ditagih. Setiap panggilan Workers AI (Llama Guard, embedding, klasifikasi, balapan jawaban) dicatat
// sebagai PERKIRAAN neuron ke D1 (`workers_ai_budget`, satu baris per hari UTC, UPSERT atomik lintas
// semua Durable Object). Ambang:
//  - RACE_CAP (8.000): pemakaian OPSIONAL (balapan jawaban Qwen + klasifikasi cadangan) dimatikan
//    untuk sisa hari itu -> jawaban hanya dari Kenari (model plan).
//  - HARD_CAP (9.500): SEMUA panggilan Workers AI dihentikan (Llama Guard fail-open ke aturan
//    deterministik, RAG jatuh ke BM25 lokal) — tetap di bawah 10.000 gratis.
// Perkiraan sengaja konservatif (token ≈ karakter/4, dibulatkan ke atas, input dihitung penuh walau
// stream dibatalkan). Harga neuron per 1M token dari tabel harga Workers AI (Nov 2026).
export const RACE_CAP = 8000;
export const HARD_CAP = 9500;

const NEURONS_PER_M: Record<string, { in: number; out: number }> = {
  "@cf/qwen/qwen3-30b-a3b-fp8": { in: 4625, out: 30475 },
  "@cf/meta/llama-guard-3-8b": { in: 44003, out: 2730 },
  "@cf/baai/bge-m3": { in: 1075, out: 0 },
  "@cf/meta/llama-3.1-8b-instruct-fast": { in: 4119, out: 34868 },
  "@cf/meta/llama-3.1-8b-instruct-fp8": { in: 13778, out: 26128 },
};
const DEFAULT_RATE = { in: 45000, out: 205000 }; // model tak dikenal -> anggap mahal (konservatif)

export function estimateNeurons(model: string, inChars: number, outChars: number): number {
  const r = NEURONS_PER_M[model] ?? DEFAULT_RATE;
  return (Math.ceil(inChars / 4) * r.in + Math.ceil(outChars / 4) * r.out) / 1_000_000;
}

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export class WorkersAiBudget {
  private usedToday = 0;
  private pending = 0;
  private loaded = false;
  private tableReady = false;

  constructor(private db: D1Database, private day = utcDay()) {}

  private async ensureTable() {
    if (this.tableReady) return;
    // Idempoten — tabel juga ada di src/db/schema.sql; dibuat malas di sini supaya deploy tanpa
    // migrasi manual tetap aman (fail-closed: error D1 -> anggap anggaran habis, lihat load()).
    await this.db.prepare("CREATE TABLE IF NOT EXISTS workers_ai_budget (day TEXT PRIMARY KEY, neurons REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    this.tableReady = true;
  }

  /** Baca pemakaian hari ini (sekali per giliran). Gagal baca -> FAIL-CLOSED (dianggap sudah HARD_CAP). */
  async load(): Promise<number> {
    try {
      await this.ensureTable();
      const v = await this.db.prepare("SELECT neurons FROM workers_ai_budget WHERE day = ?").bind(this.day).first<number>("neurons");
      this.usedToday = Number(v ?? 0);
    } catch (err: any) {
      console.error("workers_ai_budget_load_error", err?.message ?? String(err));
      this.usedToday = HARD_CAP;
    }
    this.loaded = true;
    return this.usedToday;
  }

  get used(): number {
    return this.usedToday + this.pending;
  }

  allowRace(): boolean {
    return this.loaded && this.used < RACE_CAP;
  }

  allowAny(): boolean {
    return this.loaded && this.used < HARD_CAP;
  }

  record(model: string, inChars: number, outChars: number): number {
    const n = estimateNeurons(model, inChars, outChars);
    this.pending += n;
    return n;
  }

  /** Tulis akumulasi giliran ini (UPSERT atomik). Tidak pernah melempar. */
  async flush(): Promise<void> {
    if (this.pending <= 0) return;
    const add = this.pending;
    this.pending = 0;
    try {
      await this.ensureTable();
      await this.db
        .prepare("INSERT INTO workers_ai_budget (day, neurons) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET neurons = neurons + excluded.neurons, updated_at = datetime('now')")
        .bind(this.day, add)
        .run();
      this.usedToday += add;
    } catch (err: any) {
      console.error("workers_ai_budget_flush_error", err?.message ?? String(err));
    }
  }
}

function inputChars(input: any): number {
  if (!input) return 0;
  if (Array.isArray(input.messages)) return input.messages.reduce((s: number, m: any) => s + String(m?.content ?? "").length, 0);
  if (Array.isArray(input.text)) return input.text.reduce((s: number, t: any) => s + String(t ?? "").length, 0);
  return JSON.stringify(input).length;
}

/**
 * Bungkus binding AI: setiap `run` dicek terhadap anggaran (`optional` = boleh dipakai hanya di bawah
 * RACE_CAP) dan dicatat. Output streaming dihitung dari isi `response` yang benar-benar diterima.
 */
export function meteredAi(ai: Ai, budget: WorkersAiBudget, optionalModels: Set<string>): Ai {
  return {
    run: async (model: string, input: any, options?: any) => {
      const allowed = optionalModels.has(model) ? budget.allowRace() : budget.allowAny();
      if (!allowed) throw new Error(`workers_ai_budget_cap: ${Math.round(budget.used)} neuron hari ini (cap ${optionalModels.has(model) ? RACE_CAP : HARD_CAP})`);
      const inC = inputChars(input);
      budget.record(model, inC, 0);
      const res: any = await (ai as any).run(model, input, options);
      if (res instanceof ReadableStream) {
        // Dicatat per potongan (bukan di flush) supaya stream yang DIBATALKAN (kalah balapan) tetap terhitung.
        const dec = new TextDecoder();
        return res.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, ctrl) {
              let outC = 0;
              for (const m of dec.decode(chunk, { stream: true }).matchAll(/"response"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) outC += m[1].length;
              if (outC) budget.record(model, 0, outC);
              ctrl.enqueue(chunk);
            },
          }),
        );
      }
      const out = typeof res?.response === "string" ? res.response.length : res?.data ? 0 : JSON.stringify(res ?? "").length;
      budget.record(model, 0, out);
      return res;
    },
  } as unknown as Ai;
}

// Klien Langfuse minimal berbasis fetch (Ingestion API publik), BUKAN SDK resmi `langfuse`.
//
// Keputusan desain (didokumentasikan, bukan disembunyikan — lihat README §Keputusan Desain):
// SDK Node resmi mengasumsikan proses long-lived (flush via setInterval, listener process.on("exit"),
// buffer in-memory yang di-drain oleh background timer). Cloudflare Workers TIDAK punya proses
// long-lived semacam itu di luar siklus hidup satu request — timer yang didaftarkan tidak dijamin
// jalan setelah Response dikirim kecuali didaftarkan lewat `ctx.waitUntil()`. Klien kustom ini
// mengirim SETIAP batch observasi secara eksplisit lewat `ctx.waitUntil(flush())` di akhir giliran,
// pola yang justru lebih BENAR untuk model eksekusi Workers dibanding mencoba membungkus SDK Node
// agar "terlihat jalan" di runtime yang modelnya berbeda. Trade-off: tidak mendapat retry/backoff
// bawaan SDK — gagal kirim trace cukup di-log ke console, TIDAK PERNAH melempar error yang bisa
// menjatuhkan giliran chat (observability tidak boleh mengganggu demo).
//
// Endpoint: POST {baseUrl}/api/public/ingestion — lihat https://langfuse.com/docs/api
// Auth: HTTP Basic (publicKey:secretKey) — sama seperti SDK resmi.

export interface LangfuseConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

interface IngestionEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

/** Hash satu arah pendek untuk pseudonimisasi sessionId/actorId sebelum dikirim ke Langfuse — tidak pernah PII mentah. */
export async function pseudonymize(value: string, salt: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${value}`));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 16);
}

/** Event X-Ray — skema stabil, dikonsumsi oleh panel X-Ray live (siaran WS) DAN halaman /learn
 * (worker lain, replay dari `metadata.xray` yang disimpan di tiap pesan asisten). Field DIBATASI
 * sengaja: tanpa teks mentah pengguna/LLM (lihat README §"Untuk halaman visual") — aman untuk
 * mode Publik (PII selalu termask di sini, bukan hanya "di-mask" setelah fakta). Detail generation
 * (teks LLM penuh) tetap ADA tapi hanya di Langfuse (link presenter-only), bukan di event ini. */
export interface XrayEvent {
  node: "guard_in" | "verify_identity" | "route_intent" | "tools" | "guard_out" | "respond";
  phase: "start" | "end";
  ts: string;
  durationMs?: number;
  data: Record<string, unknown>;
}

export class LangfuseTrace {
  private events: IngestionEvent[] = [];
  readonly traceId: string;

  constructor(
    private cfg: LangfuseConfig | null,
    traceId: string,
    name: string,
    input: Record<string, unknown>,
    metadata: Record<string, unknown>,
    userId?: string,
    sessionId?: string,
    private onXray?: (ev: XrayEvent) => void,
  ) {
    this.traceId = traceId;
    this.events.push({
      id: crypto.randomUUID(),
      type: "trace-create",
      timestamp: new Date().toISOString(),
      body: { id: traceId, name, input, metadata, userId, sessionId, tags: ["modal-mitra-demo", "langgraph"] },
    });
  }

  /** Span manual (dipakai untuk 1 node graph: guard_in, verify_identity, route_intent, tools, guard_out, respond). */
  span(name: string, startInput: Record<string, unknown> = {}) {
    const id = crypto.randomUUID();
    const startTime = new Date().toISOString();
    const startedAt = Date.now();
    this.events.push({ id: crypto.randomUUID(), type: "span-create", timestamp: startTime, body: { id, traceId: this.traceId, name, startTime, input: startInput } });
    this.onXray?.({ node: name as XrayEvent["node"], phase: "start", ts: startTime, data: startInput });
    return {
      end: (output: Record<string, unknown> = {}, level: "DEFAULT" | "WARNING" | "ERROR" = "DEFAULT") => {
        const durationMs = Date.now() - startedAt;
        this.events.push({
          id: crypto.randomUUID(),
          type: "span-update",
          timestamp: new Date().toISOString(),
          body: { id, traceId: this.traceId, endTime: new Date().toISOString(), output, level, metadata: { durationMs } },
        });
        this.onXray?.({ node: name as XrayEvent["node"], phase: "end", ts: new Date().toISOString(), durationMs, data: { ...output, level } });
      },
    };
  }

  /** Generation: 1 panggilan LLM (model, token in/out jika tersedia, biaya diestimasi Langfuse dari model name+token). */
  generation(name: string, model: string, input: unknown, output: string, usage?: { input?: number; output?: number }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.events.push({
      id: crypto.randomUUID(),
      type: "generation-create",
      timestamp: now,
      body: {
        id,
        traceId: this.traceId,
        name,
        model,
        startTime: now,
        endTime: now,
        input,
        output,
        usage: usage ? { input: usage.input, output: usage.output, unit: "TOKENS" } : undefined,
      },
    });
  }

  /** Skor eval (pass/fail per kasus golden-set, latensi first-token) — dipakai oleh scripts/eval-langfuse.ts. */
  score(name: string, value: number, comment?: string) {
    this.events.push({
      id: crypto.randomUUID(),
      type: "score-create",
      timestamp: new Date().toISOString(),
      body: { id: crypto.randomUUID(), traceId: this.traceId, name, value, comment },
    });
  }

  update(fields: Record<string, unknown>) {
    this.events.push({ id: crypto.randomUUID(), type: "trace-create", timestamp: new Date().toISOString(), body: { id: this.traceId, ...fields } });
  }

  /** Kirim semua event yang terkumpul dalam 1 batch. Dipanggil lewat ctx.waitUntil() — TIDAK PERNAH melempar. */
  async flush(): Promise<void> {
    if (!this.cfg || this.events.length === 0) return;
    const batch = this.events;
    this.events = [];
    try {
      const auth = btoa(`${this.cfg.publicKey}:${this.cfg.secretKey}`);
      const res = await fetch(`${this.cfg.baseUrl}/api/public/ingestion`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
        body: JSON.stringify({ batch }),
      });
      if (!res.ok) {
        console.error("langfuse_ingestion_failed", res.status, (await res.text()).slice(0, 300));
      }
    } catch (err: any) {
      console.error("langfuse_ingestion_error", err?.message ?? String(err));
    }
  }
}

export function startTrace(
  cfg: LangfuseConfig | null,
  name: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  userId?: string,
  sessionId?: string,
  onXray?: (ev: XrayEvent) => void,
): LangfuseTrace {
  return new LangfuseTrace(cfg, crypto.randomUUID(), name, input, metadata, userId, sessionId, onXray);
}

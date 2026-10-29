// Provider Kenari (OpenAI-compatible, https://kenari.id/v1) — arahan koordinator (2026-10-30):
// Kenari jadi provider LLM utama (bukan OpenRouter), paket "Studio" (kuota Rp1,2jt/bulan).
// Diverifikasi langsung via GET /v1/models + /v1/account/quota saat worktree ini ditulis:
//   - HANYA 3 model dipakai (sesuai paket Studio, tercakup kuota): deepseek-v4-1-flash (termurah/
//     tercepat, cocok tier 1 cascade), gpt-6-luna (tier 2), gpt-6-1-terra (tier 3, agentic/kompleks).
//   - gpt-6-astra SENGAJA TIDAK PERNAH dipanggil — ditagih PAYG di luar paket Studio (~10x lebih
//     mahal dari gpt-6-1-terra per token output: 1.000.000 vs 100.000 IDR/1M token). Allowlist di
//     bawah adalah pagar kode, bukan cuma aturan dokumentasi, supaya salah ketik model TIDAK bisa
//     menembus ke model mahal ini.
//   - TIDAK ADA model embeddings di katalog Kenari (`GET /v1/models` difilter endpoints=embeddings
//     -> 0 hasil) -> embedding TETAP Workers AI (BGE-M3), sesuai arahan koordinator ("bila tidak,
//     tetap Workers AI hanya untuk embedding").
// max_tokens SELALU diisi (arahan koordinator) — mencegah balasan tak terbatas membengkakkan biaya.

export type KenariModel = "deepseek-v4-1-flash" | "gpt-6-luna" | "gpt-6-1-terra";

export const KENARI_ALLOWED_MODELS: readonly KenariModel[] = [
  "deepseek-v4-1-flash",
  "gpt-6-luna",
  "gpt-6-1-terra",
];

export const KENARI_BASE_URL = "https://kenari.id/v1";

export interface KenariEnv {
  KENARI_API_KEY?: string;
  KENARI_BASE_URL?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface KenariCompletion {
  text: string;
  model: string;
  totalTokens: number;
  latencyMs: number;
}

export class KenariModelNotAllowedError extends Error {
  constructor(model: string) {
    super(`Model Kenari "${model}" tidak di allowlist paket Studio (lihat KENARI_ALLOWED_MODELS) — ditolak sebelum request terkirim, demi mencegah tagihan PAYG tak sengaja (mis. gpt-6-astra).`);
  }
}

export async function kenariChatComplete(
  env: KenariEnv,
  model: KenariModel,
  messages: ChatMessage[],
  maxTokens: number,
  fetchImpl: typeof fetch = fetch,
): Promise<KenariCompletion> {
  if (!KENARI_ALLOWED_MODELS.includes(model)) {
    throw new KenariModelNotAllowedError(model);
  }
  if (!env.KENARI_API_KEY) {
    throw new Error("KENARI_API_KEY belum diset (wrangler secret, sumber Keychain 'kenari-api-key'/'omniroute')");
  }
  const baseUrl = env.KENARI_BASE_URL || KENARI_BASE_URL;
  const startedAt = Date.now();
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.KENARI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kenari HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data: any = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return {
    text,
    model,
    totalTokens: data?.usage?.total_tokens ?? 0,
    latencyMs: Date.now() - startedAt,
  };
}

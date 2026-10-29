// Klien Kenari (OmniRoute) — proxy OpenAI-compatible (chat/completions + embeddings) milik
// Bagus sendiri (paket Studio, kuota bulanan Rp1,2 juta, TERPISAH dari project lain). Dipakai
// sebagai provider UTAMA saat ini (lihat README §Keputusan Desain "Kenari vs Workers AI") karena
// kuota gratis Workers AI akun Markas Auracheck habis untuk hari ini (error 4006) tepat saat
// migrasi ini dikerjakan — keputusan diambil setelah DIUKUR langsung: latensi gpt-6-1-terra untuk
// balasan JSON pendek ~1-2s (sebanding Workers AI saat sehat), endpoint /v1/embeddings Kenari
// mengembalikan model "bge-m3" dengan dimensi 1024 — IDENTIK dengan index Vectorize yang sudah
// ada, jadi bisa dipakai langsung tanpa migrasi index. Workers AI tetap dicoba LEBIH DULU di setiap
// panggilan (gratis saat sehat) -> Kenari hanya aktif sebagai fallback kedua, KECUALI untuk periode
// migrasi ini di mana Workers AI sedang 100% habis sehingga secara praktis Kenari yang melayani
// mayoritas trafik -> dicatat jujur, bukan diam-diam.
//
// Model yang DIPAKAI (paket Studio): gpt-6-1-terra (chat utama, JSON bersih tanpa reasoning
// overhead — diuji langsung, deepseek-v4-1-flash mengeluarkan token "reasoning" berlebihan untuk
// tugas tool-calling pendek ini). gpt-6-astra SENGAJA TIDAK dipakai (ditagih PAYG terpisah, saldo
// kecil, bukan bagian paket Studio).

const KENARI_BASE_URL = "https://kenari.id/v1";
export const KENARI_CHAT_MODEL = "gpt-6-1-terra";
export const KENARI_EMBED_MODEL = "bge-m3";

export async function kenariChatCompletion(
  apiKey: string,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; max_tokens?: number } = {},
): Promise<string | null> {
  try {
    const res = await fetch(`${KENARI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: KENARI_CHAT_MODEL,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.max_tokens ?? 1536, // WAJIB diset eksplisit (instruksi Bagus) -> batasi biaya per panggilan.
      }),
    });
    if (!res.ok) {
      console.error("kenari_chat_http_error", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data: any = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch (err: any) {
    console.error("kenari_chat_error", err?.message ?? String(err));
    return null;
  }
}

export async function kenariEmbed(apiKey: string, text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${KENARI_BASE_URL}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: KENARI_EMBED_MODEL, input: text }),
    });
    if (!res.ok) {
      console.error("kenari_embed_http_error", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data: any = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch (err: any) {
    console.error("kenari_embed_error", err?.message ?? String(err));
    return null;
  }
}

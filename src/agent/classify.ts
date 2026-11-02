// Klasifikasi intent dengan model cepat — HANYA cadangan bila aturan regex (router.ts
// classifyIntent) menghasilkan "lain" untuk pesan yang cukup panjang. Dijalankan PARALEL dengan
// Llama Guard + retrieval di guard_in (lihat graph.ts), dibatasi anggaran waktu ketat, gagal aman ke
// hasil aturan. Dua penyedia BERLOMBA (Workers AI 8B co-located vs Kenari) — yang pertama menjawab
// valid dipakai; terukur 2 Nov: klasifikasi Kenari saja 2.5–7.3 s, terlalu lambat untuk jalur kritis.
// Output JSON satu kunci supaya murah (max_tokens kecil) dan mudah divalidasi.
import { kenariChatCompletion, type KenariUsage } from "./kenari";
import type { Intent } from "./router";

const INTENTS: Intent[] = ["info", "akun", "pengajuan", "keterlambatan", "pengaduan", "hak_data", "lain"];

export const CLASSIFIER_SYSTEM_PROMPT = `Klasifikasikan pesan nasabah layanan pinjaman mikro (bahasa Indonesia, sering informal/typo/singkatan) ke SATU intent:
- keterlambatan: belum/tidak bisa bayar angsuran, telat, nunggak, minta keringanan/restrukturisasi
- akun: cek angsuran/sisa pinjaman/jadwal majelis/portofolio milik sendiri
- pengajuan: ajukan pinjaman baru/top-up/tambah plafon
- pengaduan: komplain/keluhan layanan atau penagihan
- hak_data: akses/koreksi/hapus data pribadi
- info: pertanyaan umum produk/biaya/syarat/risiko
- lain: sapaan atau di luar semua kategori
Contoh: "maap bu minggu ini blm ada uang buat setoran" -> {"intent":"keterlambatan"}
Contoh: "sisa cicilan sy brp ya" -> {"intent":"akun"}
Contoh: "bunganya brp persen sih" -> {"intent":"info"}
Balas HANYA JSON: {"intent":"<salah satu>"}`;

export interface LlmIntentResult {
  intent: Intent;
  model: string;
  ms: number;
  usage?: KenariUsage;
}

const WORKERS_CLASSIFIER = "@cf/meta/llama-3.1-8b-instruct-fast";

function parseIntent(text: string | null | undefined): Intent | null {
  const m = text?.match(/"intent"\s*:\s*"([a-z_]+)"/);
  const intent = m?.[1] as Intent | undefined;
  return intent && INTENTS.includes(intent) ? intent : null;
}

/** Lomba Workers AI vs Kenari, dibatasi `budgetMs` total. null bila tidak ada yang valid tepat waktu. */
export async function classifyIntentFast(ai: Ai, apiKey: string | undefined, redactedText: string, kenariModel: string | undefined, budgetMs = 1200): Promise<LlmIntentResult | null> {
  const t0 = Date.now();
  const workers = (async (): Promise<LlmIntentResult> => {
    const res: any = await ai.run(WORKERS_CLASSIFIER as any, {
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: redactedText.slice(0, 500) },
      ],
      max_tokens: 20,
      temperature: 0,
    });
    const intent = parseIntent(typeof res?.response === "string" ? res.response : JSON.stringify(res?.response ?? res));
    if (!intent) throw new Error("workers_classifier_invalid");
    return { intent, model: WORKERS_CLASSIFIER, ms: Date.now() - t0 };
  })();
  const kenari = apiKey
    ? classifyIntentLLM(apiKey, redactedText, kenariModel, budgetMs).then((r) => {
        if (!r) throw new Error("kenari_classifier_invalid");
        return r;
      })
    : Promise.reject(new Error("no_kenari"));
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs));
  return Promise.race([Promise.any([workers, kenari]).catch(() => null), timeout]);
}

export async function classifyIntentLLM(apiKey: string, redactedText: string, model: string | undefined, timeoutMs = 2500): Promise<LlmIntentResult | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await kenariChatCompletion(
      apiKey,
      [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: redactedText.slice(0, 500) },
      ],
      { temperature: 0, max_tokens: 30, model, signal: ctrl.signal },
    );
    const intent = parseIntent(res.text);
    if (!intent) return null;
    return { intent, model: res.model, ms: res.ms, usage: res.usage };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Klasifikasi intent dengan model cepat — HANYA cadangan bila aturan regex (router.ts
// classifyIntent) menghasilkan "lain" untuk pesan yang cukup panjang. Dijalankan PARALEL dengan
// Llama Guard + retrieval di guard_in (lihat graph.ts), dibatasi timeout, gagal aman ke hasil aturan.
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
    const m = res.text?.match(/"intent"\s*:\s*"([a-z_]+)"/);
    const intent = m?.[1] as Intent | undefined;
    if (!intent || !INTENTS.includes(intent)) return null;
    return { intent, model: res.model, ms: res.ms, usage: res.usage };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

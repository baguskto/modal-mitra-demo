// Fitur #3 (semantic cache): FAQ berulang (kebijakan/biaya/syarat — PERTANYAAN GENERIK, bukan
// data pribadi mitra/pendana tertentu) dijawab dari cache berbasis kemiripan makna (Vectorize),
// bukan hanya exact-match string, supaya "berapa biaya jasa?" dan "biaya jasanya berapa ya ka"
// sama-sama kena cache hit. SENGAJA index Vectorize TERPISAH dari KB (`CACHE_VECTORIZE`, lihat
// wrangler.toml) supaya tidak mencampur vektor cache dgn vektor dokumen RAG.
//
// Aturan privasi (brief): "jangan cache jawaban yang memuat data pribadi" — scanOutputForPII
// (guard yang SUDAH ADA di src/guards/pii.ts, tidak diduplikasi) dipanggil sebagai pagar keras
// SEBELUM simpan, terlepas dari apa yang caller klaim; kunci cache juga per-persona (mitra vs
// pendana bisa punya jawaban berbeda utk pertanyaan senada -> tidak boleh saling kena cache hit).
import { scanOutputForPII } from "../../guards/pii";
import { xrayEvent, type ExtrasXrayEvent } from "../xray";

export interface SemanticCacheEnv {
  AI: Ai;
  CACHE_VECTORIZE: VectorizeIndex;
  EMBED_MODEL: string;
}

export interface CacheLookup {
  query: string;
  persona: string;
}

export interface CacheHit {
  answer: string;
  score: number;
  cachedAt: string;
}

const SIMILARITY_THRESHOLD = 0.92; // tinggi SENGAJA: salah cache hit lebih mahal (jawaban keliru
// ke pengguna) daripada cache miss (paling buruk hanya kembali ke jalur normal/tanpa hemat biaya).
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam — kebijakan/biaya bisa berubah, jangan permanen.

async function embed(env: SemanticCacheEnv, text: string): Promise<number[] | null> {
  const res: any = await env.AI.run(env.EMBED_MODEL as any, { text: [text] });
  return res?.data?.[0] ?? res?.[0] ?? null;
}

export async function getCachedAnswer(
  env: SemanticCacheEnv,
  lookup: CacheLookup,
  sessionId?: string,
): Promise<{ hit: CacheHit | null; xray: ExtrasXrayEvent }> {
  const vector = await embed(env, lookup.query);
  if (!vector) {
    return { hit: null, xray: xrayEvent("cache_miss", { reason: "embed_failed" }, sessionId) };
  }

  const result = await env.CACHE_VECTORIZE.query(vector, { topK: 3, returnMetadata: "all" });
  const now = Date.now();
  const match = result.matches
    .filter((m) => m.score >= SIMILARITY_THRESHOLD)
    .filter((m) => String(m.metadata?.persona) === lookup.persona)
    .filter((m) => Number(m.metadata?.expiresAt ?? 0) > now)
    .sort((a, b) => b.score - a.score)[0];

  if (!match) {
    return { hit: null, xray: xrayEvent("cache_miss", { persona: lookup.persona }, sessionId) };
  }

  const hit: CacheHit = {
    answer: String(match.metadata?.answer ?? ""),
    score: match.score,
    cachedAt: String(match.metadata?.cachedAt ?? ""),
  };
  return {
    hit,
    xray: xrayEvent("cache_hit", { persona: lookup.persona, score: Number(hit.score.toFixed(3)) }, sessionId),
  };
}

export interface StoreCacheInput {
  query: string;
  persona: string;
  answer: string;
  ttlMs?: number;
}

export async function storeCachedAnswer(
  env: SemanticCacheEnv,
  input: StoreCacheInput,
): Promise<{ stored: boolean; reason?: string }> {
  const piiScan = scanOutputForPII(input.answer);
  if (!piiScan.clean) {
    return { stored: false, reason: `menolak cache: PII terdeteksi di jawaban (${piiScan.findings.join(", ")})` };
  }

  const vector = await embed(env, input.query);
  if (!vector) return { stored: false, reason: "embed_failed" };

  const now = Date.now();
  const id = `cache-${input.persona}-${now}-${Math.random().toString(36).slice(2, 8)}`;
  await env.CACHE_VECTORIZE.upsert([
    {
      id,
      values: vector,
      metadata: {
        persona: input.persona,
        answer: input.answer,
        cachedAt: new Date(now).toISOString(),
        expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
      },
    },
  ]);
  return { stored: true };
}

export { SIMILARITY_THRESHOLD, DEFAULT_TTL_MS };

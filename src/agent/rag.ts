// Retrieval RAG.
//
// feat/latency-xray (2 Nov 2026):
//  1. Embedding kueri sekarang Workers AI `@cf/baai/bge-m3` (binding AI, co-located dengan Worker),
//     BUKAN lagi Kenari — `bge-m3` di Kenari ditagih PAYG (tidak ada di scope_models paket Studio,
//     terlihat di GET /v1/usage). Index Vectorize memang di-ingest dengan model Workers AI yang sama
//     (src/index.ts /api/admin/ingest), jadi kueri & dokumen kini satu ruang vektor yang identik.
//  2. Kueri yang di-embed adalah teks TEREDAKSI (token [PINJAMAN_1] dst.), bukan teks mentah pengguna.
//  3. Timeout + fallback BM25 lokal (korpus di-bundle, src/agent/kbCorpus.ts): kuota Workers AI habis /
//     Vectorize lambat -> retrieval leksikal in-process (<5 ms), bukan "RAG kosong".
//  4. Mengembalikan detail untuk X-Ray (metode, durasi embed/query, skor per dokumen).
import { KB_CHUNKS } from "./kbCorpus";

export interface RetrievedChunk {
  id: string; // format doc_id#chunk_id, dipakai sebagai token sitasi [doc_id#chunk_id]
  docId: string;
  text: string;
  score: number;
  needsVerification: boolean;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  method: "vector" | "bm25_fallback";
  embedMs?: number;
  queryMs?: number;
  ms: number;
  fallbackReason?: string;
  /** Top-k sebelum ambang skor (untuk X-Ray: dokumen yang dipertimbangkan tapi dibuang). */
  considered: { id: string; score: number }[];
}

const SCORE_THRESHOLD = 0.45; // vektor: di bawah ini dianggap tidak relevan -> fallback "tidak tahu"
const BM25_MIN_SCORE = 1.5; // BM25: skor mentah minimum (tanpa normalisasi) agar dianggap relevan
const RETRIEVAL_TIMEOUT_MS = 2500;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms))]);
}

export async function retrieve(ai: Ai, vectorize: VectorizeIndex, embedModel: string, query: string, topK = 6): Promise<RetrievalResult> {
  const t0 = Date.now();
  try {
    const embedStart = Date.now();
    const embedRes: any = await withTimeout(ai.run(embedModel as any, { text: [query] }), RETRIEVAL_TIMEOUT_MS, "embed");
    const vector: number[] | null = embedRes?.data?.[0] ?? embedRes?.[0] ?? null;
    const embedMs = Date.now() - embedStart;
    if (!vector || vector.length !== 1024) throw new Error(`embed_dim_${vector?.length ?? 0}`);
    const queryStart = Date.now();
    const result = await withTimeout(vectorize.query(vector, { topK, returnMetadata: "all" }), RETRIEVAL_TIMEOUT_MS, "vectorize");
    const queryMs = Date.now() - queryStart;
    const all = result.matches.map((m) => ({
      id: String(m.metadata?.chunk_ref ?? m.id),
      docId: String(m.metadata?.doc_id ?? "unknown"),
      text: String(m.metadata?.text ?? ""),
      score: m.score,
      needsVerification: Boolean(m.metadata?.needs_verification),
    }));
    return {
      chunks: all.filter((c) => c.score >= SCORE_THRESHOLD),
      method: "vector",
      embedMs,
      queryMs,
      ms: Date.now() - t0,
      considered: all.map((c) => ({ id: c.id, score: round(c.score) })),
    };
  } catch (err: any) {
    // Degradasi anggun: kuota/ketersediaan Workers AI/Vectorize terganggu -> BM25 lokal, bukan RAG kosong.
    console.error("rag_vector_error_fallback_bm25", err?.message ?? String(err));
    const scored = bm25Search(query, topK);
    return {
      chunks: scored.filter((c) => c.score >= BM25_MIN_SCORE),
      method: "bm25_fallback",
      ms: Date.now() - t0,
      fallbackReason: String(err?.message ?? err).slice(0, 80),
      considered: scored.map((c) => ({ id: c.id, score: round(c.score) })),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// --- BM25 (Okapi, k1=1.2, b=0.75) atas korpus KB yang di-bundle ---
const STOPWORDS = new Set("yang dan di ke dari untuk dengan ini itu ada apa saya sy aku kamu anda bu pak ya ga gak tidak atau juga akan sudah belum blm bisa kalau kalo jika dalam pada oleh sebagai karena adalah mau gimana bagaimana berapa brp sih dong kak".split(" "));

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[[a-z_]+_\d+\]/g, " ") // token redaksi PII bukan sinyal topik
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map(stem);
}

// Stemming sangat ringan Bahasa Indonesia (akhiran umum) — cukup untuk "angsuran"/"angsurannya".
function stem(t: string): string {
  return t.replace(/(nya|lah|kah|pun)$/, "").replace(/(kan|an|i)$/, (m, _g, off) => (off > 4 ? "" : m));
}

const DOCS = KB_CHUNKS.map((c) => ({ c, toks: tokenize(`${c.heading} ${c.text}`) }));
const AVGDL = DOCS.reduce((s, d) => s + d.toks.length, 0) / Math.max(1, DOCS.length);
const DF = new Map<string, number>();
for (const d of DOCS) for (const t of new Set(d.toks)) DF.set(t, (DF.get(t) ?? 0) + 1);

export function bm25Search(query: string, topK = 6): RetrievedChunk[] {
  const q = [...new Set(tokenize(query))];
  const N = DOCS.length;
  const k1 = 1.2;
  const b = 0.75;
  const scored = DOCS.map(({ c, toks }) => {
    let score = 0;
    for (const term of q) {
      const df = DF.get(term);
      if (!df) continue;
      const tf = toks.filter((t) => t === term).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * toks.length) / AVGDL)));
    }
    return { id: c.chunk_ref, docId: c.doc_id, text: c.text, score, needsVerification: c.needs_verification };
  });
  return scored.filter((s) => s.score > 0).sort((a, b2) => b2.score - a.score).slice(0, topK);
}

export function formatChunksAsContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "(tidak ada dokumen relevan ditemukan di atas ambang skor)";
  return chunks
    .map((c) => {
      const warn = c.needsVerification ? " [PERLU DICEK — ringkasan regulasi, bukan kutipan resmi]" : "";
      return `[${c.id}]${warn} ${c.text}`;
    })
    .join("\n---\n");
}

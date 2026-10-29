import { kenariEmbed } from "./kenari";

export interface RetrievedChunk {
  id: string; // format doc_id#chunk_id, dipakai sebagai token sitasi [doc_id#chunk_id]
  docId: string;
  text: string;
  score: number;
  needsVerification: boolean;
}

const SCORE_THRESHOLD = 0.45; // di bawah ini dianggap tidak relevan -> fallback "tidak tahu"

export async function retrieve(
  ai: Ai,
  vectorize: VectorizeIndex,
  embedModel: string,
  query: string,
  topK = 8,
  kenariApiKey?: string,
): Promise<RetrievedChunk[]> {
  // Kenari dicoba LEBIH DULU saat ini (lihat alasan terukur di agent/llm.ts) — endpoint
  // /v1/embeddings model "bge-m3" mengembalikan 1024 dimensi, IDENTIK dengan index Vectorize ini,
  // jadi bisa dipakai langsung. Workers AI (`embedModel`) tetap cadangan.
  let vector: number[] | null = null;
  if (kenariApiKey) {
    vector = await kenariEmbed(kenariApiKey, query);
  }
  if (!vector) {
    try {
      const embedRes: any = await ai.run(embedModel as any, { text: [query] });
      vector = embedRes?.data?.[0] ?? embedRes?.[0] ?? null;
    } catch (err: any) {
      // Degradasi anggun: kuota/ketersediaan Workers AI terganggu -> RAG kosong (jalur fallback
      // "tidak ditemukan"/handoff yang SUDAH ada menangani ini), bukan menjatuhkan seluruh giliran.
      console.error("rag_embed_error", err?.message ?? String(err));
      return [];
    }
  }
  if (!vector) return [];

  const result = await vectorize.query(vector, { topK, returnMetadata: "all" });
  const chunks: RetrievedChunk[] = result.matches
    .filter((m) => m.score >= SCORE_THRESHOLD)
    .map((m) => ({
      id: String(m.metadata?.chunk_ref ?? m.id),
      docId: String(m.metadata?.doc_id ?? "unknown"),
      text: String(m.metadata?.text ?? ""),
      score: m.score,
      needsVerification: Boolean(m.metadata?.needs_verification),
    }));
  return chunks;
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

// Chunking KB: potong per heading "## " (mirror "potong per pasal/ayat" di proposal, versi markdown).
// Setiap chunk punya chunk_ref stabil "doc_id#index" yang dipakai sebagai token sitasi [doc_id#index].
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KB_DIR = "data/synthetic/kb";

interface Chunk {
  doc_id: string;
  chunk_ref: string;
  heading: string;
  text: string;
  source_type: string;
  needs_verification: boolean;
}

function parseHeader(content: string) {
  const m = content.match(/<!--\s*doc_id:\s*([\w-]+)\s*\|\s*source_type:\s*([\w_]+)\s*\|\s*version:\s*([^|]+)\|\s*needs_verification:\s*(true|false)\s*-->/);
  if (!m) throw new Error("Header metadata tidak ditemukan di file KB");
  return { doc_id: m[1], source_type: m[2], version: m[3].trim(), needs_verification: m[4] === "true" };
}

const chunks: Chunk[] = [];

for (const file of readdirSync(KB_DIR)) {
  if (!file.endsWith(".md")) continue;
  const content = readFileSync(join(KB_DIR, file), "utf-8");
  const header = parseHeader(content);
  const body = content.replace(/<!--[\s\S]*?-->/g, "").trim(); // buang komentar HTML (termasuk payload uji adversarial & header)
  const sections = body.split(/\n(?=## )/g);
  let idx = 0;
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.startsWith("# ")) continue; // lewati judul dokumen level-1 saja
    idx += 1;
    const headingMatch = trimmed.match(/^## (.+)$/m);
    const heading = headingMatch ? headingMatch[1] : `bagian-${idx}`;
    chunks.push({
      doc_id: header.doc_id,
      chunk_ref: `${header.doc_id}#${idx}`,
      heading,
      text: trimmed.replace(/^## .+\n?/, "").trim(),
      source_type: header.source_type,
      needs_verification: header.needs_verification,
    });
  }
}

writeFileSync("data/synthetic/kb-chunks.json", JSON.stringify(chunks, null, 2));
// feat/latency-xray: korpus yang sama di-bundle ke Worker untuk fallback BM25 lokal (src/agent/rag.ts)
// bila embedding Workers AI/Vectorize gagal atau melewati timeout. Chunk adversarial (adv-test) ikut,
// sama seperti di Vectorize, supaya perilaku guard terhadap injeksi tidak langsung tetap teruji.
writeFileSync(
  "src/agent/kbCorpus.ts",
  `// GENERATED oleh scripts/chunk-kb.ts — jangan edit manual.\nexport interface KbChunk { chunk_ref: string; doc_id: string; heading: string; text: string; needs_verification: boolean }\nexport const KB_CHUNKS: KbChunk[] = ${JSON.stringify(
    chunks.map((c) => ({ chunk_ref: c.chunk_ref, doc_id: c.doc_id, heading: c.heading, text: c.text, needs_verification: c.needs_verification })),
    null,
    1,
  )};\n`,
);
console.log(`Generated ${chunks.length} chunks from KB docs.`);
for (const c of chunks) console.log(`  ${c.chunk_ref} — ${c.heading}`);

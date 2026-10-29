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
console.log(`Generated ${chunks.length} chunks from KB docs.`);
for (const c of chunks) console.log(`  ${c.chunk_ref} — ${c.heading}`);

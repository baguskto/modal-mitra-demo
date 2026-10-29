// Memanggil endpoint /api/admin/ingest pada worker yang sudah dideploy (atau dev) untuk
// embed + upsert seluruh chunk KB ke Vectorize. Jalankan: npx tsx scripts/run-ingest.ts <base_url> <admin_key>
import { readFileSync } from "node:fs";

const baseUrl = process.argv[2];
const adminKey = process.argv[3];
if (!baseUrl || !adminKey) {
  console.error("Usage: tsx scripts/run-ingest.ts <base_url> <admin_key>");
  process.exit(1);
}

const chunks = JSON.parse(readFileSync("data/synthetic/kb-chunks.json", "utf-8"));
const BATCH = 4;

async function main() {
  let total = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const res = await fetch(`${baseUrl}/api/admin/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify({ chunks: batch }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("Gagal pada batch", i, data);
      process.exit(1);
    }
    total += (data as any).inserted;
    console.log(`Batch ${i}-${i + batch.length}: inserted=${(data as any).inserted}`);
  }
  console.log(`Total chunk ter-ingest: ${total}`);
}

main();

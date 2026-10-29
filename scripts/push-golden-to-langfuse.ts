// Memindahkan golden set 45 kasus (evals/promptfooconfig.yaml, sumber kebenaran yang sama dipakai
// scripts/run-eval.ts) ke Langfuse Dataset, lewat REST API publik langsung (konsisten dengan
// src/obs/langfuse.ts — klien kustom fetch, bukan SDK Node, lihat README §5.1). Jalankan sekali
// (atau tiap golden set berubah): npx tsx scripts/push-golden-to-langfuse.ts
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL || "https://jp.cloud.langfuse.com";
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;
export const DATASET_NAME = "modal-mitra-golden-45";

if (!PUBLIC_KEY || !SECRET_KEY) {
  console.error("Set LANGFUSE_PUBLIC_KEY & LANGFUSE_SECRET_KEY di env (lihat Keychain 'langfuse-public-key'/'langfuse-secret-key' akun 'modal-mitra').");
  process.exit(1);
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;
}

interface TestCase {
  description: string;
  vars: { sessionId: string; persona?: string; message: string };
  assert: { type: string; value: string }[];
}

async function main() {
  const config = parse(readFileSync("evals/promptfooconfig.yaml", "utf-8"));
  const tests: TestCase[] = config.tests;

  const dsRes = await fetch(`${LANGFUSE_BASE_URL}/api/public/v2/datasets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authHeader() },
    body: JSON.stringify({ name: DATASET_NAME, description: "45 kasus golden set Modal Mitra Contoh (sama dengan evals/promptfooconfig.yaml) — RAG+sitasi, tool-calling, HITL, adversarial/red-team, bahasa informal." }),
  });
  if (!dsRes.ok && dsRes.status !== 409) {
    console.error("Gagal membuat dataset:", dsRes.status, await dsRes.text());
    process.exit(1);
  }
  console.log(`Dataset '${DATASET_NAME}' siap.`);

  let pushed = 0;
  for (const t of tests) {
    const res = await fetch(`${LANGFUSE_BASE_URL}/api/public/dataset-items`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader() },
      body: JSON.stringify({
        datasetName: DATASET_NAME,
        id: t.vars.sessionId, // idempotent: re-run menimpa item yang sama, bukan duplikat
        input: { text: t.vars.message, persona: t.vars.persona || "mitra" },
        expectedOutput: null,
        metadata: { description: t.description, assert: t.assert },
      }),
    });
    if (res.ok) pushed += 1;
    else console.error(`Gagal push ${t.description}:`, res.status, (await res.text()).slice(0, 200));
  }
  console.log(`${pushed}/${tests.length} item dataset ter-push ke Langfuse.`);
}

// Guard import: run-langfuse-eval.ts hanya butuh DATASET_NAME, tidak boleh memicu main() lagi.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

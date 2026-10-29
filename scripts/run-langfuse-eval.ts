// Menjalankan eksperimen eval di Langfuse: untuk tiap item Dataset (lihat push-golden-to-langfuse.ts)
// panggil worker yang sudah dideploy (endpoint sama dengan scripts/run-eval.ts), evaluasi assertion
// yang SAMA, lalu link hasilnya ke Dataset Run di Langfuse via `dataset-run-items` + skor
// pass/fail per kasus dan latensi first-token — bisa dibandingkan run-ke-run langsung di UI Langfuse.
// Jalankan: npx tsx scripts/run-langfuse-eval.ts [base_url] [run_name]
import { DATASET_NAME } from "./push-golden-to-langfuse";

const BASE_URL = process.argv[2] || process.env.MMK_BASE_URL || "https://modal-mitra-demo-v2.markas-auracheck.workers.dev";
const RUN_NAME = process.argv[3] || `run-${new Date().toISOString()}`;
const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL || "https://jp.cloud.langfuse.com";
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;

if (!PUBLIC_KEY || !SECRET_KEY) {
  console.error("Set LANGFUSE_PUBLIC_KEY & LANGFUSE_SECRET_KEY di env.");
  process.exit(1);
}
function authHeader(): string {
  return `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;
}

function evalAssertion(a: { type: string; value: string }, output: string): boolean {
  switch (a.type) {
    case "icontains":
      return output.toLowerCase().includes(a.value.toLowerCase());
    case "not-contains":
      return !output.includes(a.value);
    case "not-regex":
      return !new RegExp(a.value, "i").test(output);
    case "javascript": {
      // eslint-disable-next-line no-new-func
      const fn = new Function("output", `return (${a.value});`);
      try {
        return !!fn(output);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

async function main() {
  let page = 1;
  let allItems: any[] = [];
  for (;;) {
    const res = await fetch(`${LANGFUSE_BASE_URL}/api/public/dataset-items?datasetName=${encodeURIComponent(DATASET_NAME)}&page=${page}&limit=50`, {
      headers: { authorization: authHeader() },
    });
    if (!res.ok) {
      console.error("Gagal ambil dataset items:", res.status, await res.text());
      process.exit(1);
    }
    const data: any = await res.json();
    allItems = allItems.concat(data.data ?? []);
    if (!data.data || data.data.length < 50) break;
    page += 1;
  }
  console.log(`${allItems.length} item dataset ditemukan. Menjalankan run '${RUN_NAME}'...`);

  let passCount = 0;
  for (const item of allItems) {
    const sessionId = `${item.id}-${RUN_NAME.replace(/[^a-z0-9-]/gi, "")}`;
    const t0 = Date.now();
    const res = await fetch(`${BASE_URL}/api/chat/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: item.input.text, persona: item.input.persona }),
    });
    const data: any = await res.json();
    const output = JSON.stringify(data);
    const asserts: { type: string; value: string }[] = item.metadata?.assert ?? [];
    const pass = asserts.every((a) => evalAssertion(a, output));
    if (pass) passCount += 1;

    // Link ke dataset run (butuh traceId nyata -> dikembalikan backend di field `traceId`).
    if (data.traceId) {
      await fetch(`${LANGFUSE_BASE_URL}/api/public/dataset-run-items`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authHeader() },
        body: JSON.stringify({ runName: RUN_NAME, datasetItemId: item.id, traceId: data.traceId }),
      }).catch(() => {});
      await fetch(`${LANGFUSE_BASE_URL}/api/public/scores`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authHeader() },
        body: JSON.stringify({ traceId: data.traceId, name: "eval_pass", value: pass ? 1 : 0, comment: item.metadata?.description }),
      }).catch(() => {});
      await fetch(`${LANGFUSE_BASE_URL}/api/public/scores`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authHeader() },
        body: JSON.stringify({ traceId: data.traceId, name: "first_token_ms_eval", value: data.timing?.firstTokenMs ?? Date.now() - t0 }),
      }).catch(() => {});
    }
    console.log(`${pass ? "PASS" : "FAIL"} — ${item.metadata?.description ?? item.id}`);
  }
  console.log(`\n=== ${passCount}/${allItems.length} lulus (run '${RUN_NAME}', lihat tab Datasets di Langfuse) ===`);
}

main();

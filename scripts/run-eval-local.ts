// Golden eval (evals/promptfooconfig.yaml, assertion yang SAMA dengan scripts/run-eval.ts) dijalankan
// LOKAL lewat runAgentGraph langsung — tanpa wrangler/deploy. Lingkungan = scripts/measure-golden.ts:
// D1 node:sqlite + seed sintetis, Kenari nyata (model plan), Workers AI/Vectorize distub (retrieval
// BM25 lokal, Llama Guard simulasi "safe"). Output tiap kasus berbentuk sama dengan respons
// POST /api/chat/:id/message (reply/citations/intent/toolCallsMade/blockedByGuard/timing).
//   KENARI_API_KEY=$(security find-generic-password -s kenari-api-key -w) npx tsx scripts/run-eval-local.ts [filter]
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { createD1 } from "./harness/d1shim";
import { runAgentGraph } from "../src/agent/graph";
import { configureAuditHmac } from "../src/obs/audit";

interface Assertion { type: string; value: string }
interface TestCase { description: string; vars: { sessionId: string; persona?: string; message: string }; assert: Assertion[] }

const FILTER = process.argv[2] ? new RegExp(process.argv[2]) : null;
const tests: TestCase[] = parse(readFileSync("evals/promptfooconfig.yaml", "utf-8")).tests.filter((t: TestCase) => !FILTER || FILTER.test(t.description));

function evalAssertion(a: Assertion, output: string): boolean {
  switch (a.type) {
    case "icontains":
      return output.toLowerCase().includes(a.value.toLowerCase());
    case "not-contains":
      return !output.includes(a.value);
    case "not-regex":
      return !new RegExp(a.value, "i").test(output);
    case "javascript":
      try {
        // eslint-disable-next-line no-new-func
        return !!new Function("output", `return (${a.value});`)(output);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

const ai = {
  run: async (model: string) => {
    if (/llama-guard/.test(model)) {
      await new Promise((r) => setTimeout(r, 400));
      return { response: "safe" };
    }
    throw new Error("4006: workers ai tidak terjangkau dari harness Node");
  },
} as unknown as Ai;
const vectorize = { query: async () => { throw new Error("vectorize stub"); } } as unknown as VectorizeIndex;

async function main() {
  if (!process.env.KENARI_API_KEY) throw new Error("KENARI_API_KEY kosong");
  configureAuditHmac("harness-local-hmac-key");
  const results: { description: string; pass: boolean; failed: string[]; output: string }[] = [];
  for (const t of tests) {
    const env = {
      AI: ai,
      VECTORIZE: vectorize,
      DB: createD1({ latencyMs: 0 }),
      MODEL_PRIMARY: "@cf/qwen/qwen3-30b-a3b-fp8",
      MODEL_GUARD: "@cf/meta/llama-guard-3-8b",
      EMBED_MODEL: "@cf/baai/bge-m3",
      KENARI_API_KEY: process.env.KENARI_API_KEY,
      KENARI_CHAT_MODEL: "gpt-6-luna",
      KENARI_HEDGE_MODEL: "deepseek-v4-1-flash",
      LLM_HEDGE_AFTER_MS: "1500",
      WORKERS_AI_RACE_AFTER_MS: "0",
    };
    const persona = (t.vars.persona || "mitra") as "mitra" | "pendana";
    const out = await runAgentGraph(env, { sessionId: `evallocal-${t.vars.sessionId}`, persona, userText: t.vars.message, history: [], verifiedActorId: null, failedUnderstandingCount: 0 });
    const output = JSON.stringify({
      reply: out.answerText,
      citations: out.citations,
      intent: out.intent,
      mode: out.handoff.triggered ? "HUMAN" : "AI",
      verifiedActorId: out.verifiedActorId,
      persona,
      toolCallsMade: out.toolCallsMade,
      modelUsed: out.modelUsed,
      blockedByGuard: out.blockedByGuard,
      timing: out.timing,
    });
    const failed = t.assert.filter((a) => !evalAssertion(a, output)).map((a) => `${a.type}: ${a.value.slice(0, 80)}`);
    results.push({ description: t.description, pass: failed.length === 0, failed, output });
    console.log(`${failed.length ? "FAIL" : "PASS"} ${t.description}${failed.length ? ` -> ${failed.join(" | ")}` : ""}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const summary = { mode: "local-harness (BM25, Workers AI stub)", measuredAt: new Date().toISOString(), total: results.length, passed, failed: results.length - passed, results };
  if (!FILTER) writeFileSync("evals/results-local.json", JSON.stringify(summary, null, 2));
  console.log(`\n${passed}/${results.length} lulus`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

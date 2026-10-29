// Runner eval mandiri yang membaca evals/promptfooconfig.yaml langsung (TANPA bergantung pada CLI
// `promptfoo` + SQLite results DB-nya — di environment ini kombinasi promptfoo 0.100.6 + better-
// sqlite3 yang terpasang mengalami "FOREIGN KEY constraint failed" bahkan pada config paling
// trivial sekalipun, bug environment yang tidak terkait dengan golden set ini). Format assertion
// yang didukung (subset promptfoo yang dipakai golden set ini): icontains, not-contains, not-regex,
// javascript. Jalankan: npx tsx scripts/run-eval.ts [base_url]
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const BASE_URL = process.argv[2] || process.env.MMK_BASE_URL || "https://modal-mitra-demo.markas-auracheck.workers.dev";
const RUN_SUFFIX = Date.now().toString(36);

interface Assertion { type: string; value: string }
interface TestCase { description: string; vars: { sessionId: string; persona?: string; message: string }; assert: Assertion[] }

const config = parse(readFileSync("evals/promptfooconfig.yaml", "utf-8"));
const tests: TestCase[] = config.tests;

function evalAssertion(a: Assertion, output: string): { pass: boolean; reason?: string } {
  switch (a.type) {
    case "icontains":
      return { pass: output.toLowerCase().includes(a.value.toLowerCase()) };
    case "not-contains":
      return { pass: !output.includes(a.value) };
    case "not-regex":
      return { pass: !new RegExp(a.value, "i").test(output) };
    case "javascript": {
      // eslint-disable-next-line no-new-func
      const fn = new Function("output", `return (${a.value});`);
      try {
        return { pass: !!fn(output) };
      } catch (err: any) {
        return { pass: false, reason: `exception: ${err?.message}` };
      }
    }
    default:
      return { pass: false, reason: `assertion type tidak didukung: ${a.type}` };
  }
}

async function callCase(t: TestCase): Promise<string> {
  const sessionId = `${t.vars.sessionId}-${RUN_SUFFIX}`;
  const persona = t.vars.persona || "mitra";
  const res = await fetch(`${BASE_URL}/api/chat/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: t.vars.message, persona }),
  });
  const data = await res.json();
  return JSON.stringify(data);
}

async function main() {
  const results: { description: string; pass: boolean; failures: string[]; output: string }[] = [];
  let passCount = 0;

  for (const t of tests) {
    const output = await callCase(t);
    const failures: string[] = [];
    for (const a of t.assert) {
      const r = evalAssertion(a, output);
      if (!r.pass) failures.push(`[${a.type}] ${a.value}${r.reason ? ` (${r.reason})` : ""}`);
    }
    const pass = failures.length === 0;
    if (pass) passCount += 1;
    results.push({ description: t.description, pass, failures, output });
    console.log(`${pass ? "PASS" : "FAIL"} — ${t.description}${pass ? "" : "\n  " + failures.join("\n  ")}`);
  }

  const summary = {
    baseUrl: BASE_URL,
    measuredAt: new Date().toISOString(),
    total: tests.length,
    passed: passCount,
    failed: tests.length - passCount,
    results,
  };
  writeFileSync("evals/results.json", JSON.stringify(summary, null, 2));
  console.log(`\n=== ${passCount}/${tests.length} lulus ===`);
  console.log("Detail ditulis ke evals/results.json");
}

main();

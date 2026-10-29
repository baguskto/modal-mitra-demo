// Runner eval untuk fitur tambahan (feat/extras) — membaca evals/extras-eval.yaml dan
// mengevaluasi langsung terhadap fungsi murni di src/extras/* (tanpa endpoint live, karena
// fitur-fitur ini belum digabung ke ChatAgent/graph saat worktree ini ditulis — lihat README
// §Extras). Pola sama dengan scripts/run-eval.ts (runner mandiri, bukan CLI promptfoo yang
// bermasalah di environment ini). Jalankan: npx tsx scripts/run-extras-eval.ts
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { detectLanguage } from "../src/extras/language";
import { estimateComplexity } from "../src/extras/cache/modelRouter";
import { KENARI_ALLOWED_MODELS } from "../src/extras/cache/kenariProvider";

interface Case {
  feature: string;
  description: string;
  type: string;
  input: string;
  step_index?: number;
  expect: string | number | boolean;
}

const COMPLEXITY_START_TIER = { simple: 1, moderate: 2, complex: 3 } as const;

const config = parse(readFileSync("evals/extras-eval.yaml", "utf-8"));
const cases: Case[] = config.cases;

function runCase(c: Case): { pass: boolean; actual?: string; reason?: string } {
  switch (c.type) {
    case "language_equals": {
      const actual = detectLanguage(c.input).language;
      return { pass: actual === c.expect, actual };
    }
    case "complexity_starts_tier": {
      const complexity = estimateComplexity(c.input, c.step_index ?? 0);
      const actual = COMPLEXITY_START_TIER[complexity];
      return { pass: actual === c.expect, actual: String(actual) };
    }
    case "kenari_model_rejected": {
      const actual = !KENARI_ALLOWED_MODELS.includes(c.input as any);
      return { pass: actual === c.expect, actual: String(actual) };
    }
    default:
      return { pass: false, reason: `unknown assertion type: ${c.type}` };
  }
}

let passed = 0;
const results: { description: string; pass: boolean; detail: string }[] = [];
for (const c of cases) {
  const { pass, actual, reason } = runCase(c);
  if (pass) passed += 1;
  results.push({
    description: c.description,
    pass,
    detail: pass ? "ok" : reason ?? `expected ${c.expect}, got ${actual}`,
  });
}

for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.description}  ${r.pass ? "" : `-- ${r.detail}`}`);
}
console.log(`\n${passed}/${cases.length} lulus`);
if (passed !== cases.length) process.exit(1);

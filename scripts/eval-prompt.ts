/**
 * The "prompt regression suite" — `npm run test:prompts`.
 * Calls the REAL configured LLM (createLlmClient()) against the case set in
 * tests/evals/cases/, so it costs real API calls and is non-deterministic by
 * nature; it deliberately runs on demand, never in CI on every commit (see
 * vitest.config.ts, which excludes tests/evals/ entirely).
 *
 * Usage:
 *   npm run test:prompts
 *     — evaluates src/operator/prompt.md as-is, 3 trials per case.
 *
 *   npm run test:prompts -- --prompt path/to/candidate.md
 *     — evaluates a candidate prompt file instead of the live one, so you can
 *       judge a rewrite before it ever touches src/operator/prompt.md.
 *
 *   npm run test:prompts -- --compare old.md new.md
 *     — runs BOTH variants against the same case set and prints them side by
 *       side. This is how the prompt-length regression that motivated this
 *       whole suite was first confirmed (3/3 tool calls on the old prompt,
 *       1/3 on the new one) — before this script existed, as a throwaway.
 *
 *   npm run test:prompts -- --trials 5 --cases forget-my-data.single-turn
 *     — more trials, one case only (comma-separated ids to run several).
 *
 *   npm run test:prompts -- --delay-ms 5000
 *     — widen the pause between requests (default 3000ms) if you're still
 *       seeing rate-limit retries in the output; --delay-ms 0 to disable.
 *
 * Pushes results to Langfuse automatically whenever it's configured
 * (LANGFUSE_PUBLIC_KEY/SECRET_KEY in .env) — same "just works when
 * configured, silently no-ops otherwise" convention as every other optional
 * provider in this repo. Each run gets a named Langfuse dataset run
 * (--langfuse-run, or an auto-generated name), so two runs can be compared
 * side by side in Langfuse's own UI, not just in this script's console table.
 */
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { buildTools } from "../src/operator/tools.js";
import { flushTracing } from "../src/agent/llm/index.js";
import { runSuite, stubToolResult } from "../tests/evals/runner.js";
import { ALL_CASES } from "../tests/evals/cases/index.js";
import type { EvalCase, PromptVariant, CaseRunResult } from "../tests/evals/types.js";

const DEFAULT_PROMPT_PATH = "src/operator/prompt.md";
const DEFAULT_TRIALS = 3;
// Empirically tuned against a real run: firing trials back-to-back against
// free-tier Mistral left 2 of 10 case×variant cells with zero usable trials
// (every attempt AND its retry both rate-limited); the reactive 5s
// retry-after-429 in tests/evals/runner.ts wasn't enough on its own. 3s
// between requests is proactive pacing on top of that, not a replacement —
// tune down for a paid tier, up for a stricter free one.
const DEFAULT_DELAY_MS = 3000;

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function getArgList(name: string): string[] | undefined {
  const value = getArg(name);
  return value ? value.split(",").map((s) => s.trim()) : undefined;
}

/**
 * `--compare` takes TWO space-separated paths (`--compare old.md new.md`), unlike
 * `--cases`, which takes one comma-separated token (`--cases a,b,c`). Reusing
 * getArgList for `--compare` (as an earlier version of this file did) reads
 * `process.argv[idx + 1]` only — the single token right after the flag — so
 * `--compare a.md b.md` silently captured just `a.md`: `variants` always had
 * exactly one entry, no error, no crash, `--compare` behaved identically to
 * `--prompt`. Caught by a from a real comparison run whose second variant
 * never printed a single line — confirmed with `--trials 1` (no rate limiting
 * involved) that it wasn't a quota issue, it was this.
 */
function getArgPair(name: string): [string, string] | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) {
    return undefined;
  }
  const a = process.argv[idx + 1];
  const b = process.argv[idx + 2];
  if (!a || !b || a.startsWith("--") || b.startsWith("--")) {
    throw new Error(`--${name} requires two space-separated paths, e.g. --${name} old.md new.md`);
  }
  return [a, b];
}

function loadVariant(path: string): PromptVariant {
  if (!existsSync(path)) {
    throw new Error(`Prompt file not found: ${path}`);
  }
  return {
    name: basename(path),
    systemPromptBase: readFileSync(path, "utf-8"),
    // A stub handler with no per-trial state — callOnce (runner.ts) derives
    // toolsCalled from the invoked agent's own message history afterward, not
    // from this closure, so the same tool set is safe to reuse across every
    // trial and case for this variant without cross-trial contamination.
    tools: buildTools(async (name) => stubToolResult(name)),
  };
}

function selectCases(ids: string[] | undefined): EvalCase[] {
  if (!ids) {
    return ALL_CASES;
  }
  const byId = new Map(ALL_CASES.map((c) => [c.id, c]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown case id(s): ${missing.join(", ")}. Known: ${[...byId.keys()].join(", ")}`);
  }
  return ids.map((id) => byId.get(id)!);
}

function formatMeanScore(meanScore: number | null): string {
  return meanScore === null ? "N/A" : meanScore.toFixed(2);
}

function formatCaseResult(result: CaseRunResult): string {
  const perTrial = result.trials
    .map((t) => (!t.assertion ? "E" : t.assertion.score === 1 ? "✓" : t.assertion.score === 0 ? "✗" : "~"))
    .join(" ");
  const last = result.trials[result.trials.length - 1];
  const lastReason = last?.assertion?.reason ?? (last?.result.error ? `errored: ${last.result.error}` : "");
  const meanLabel = result.meanScore === null ? "N/A (all trials errored)" : formatMeanScore(result.meanScore);
  return `  ${result.caseId.padEnd(45)} [${perTrial}]  mean=${meanLabel}  (${lastReason})`;
}

async function main() {
  const comparePaths = getArgPair("compare");
  const singlePath = getArg("prompt") ?? DEFAULT_PROMPT_PATH;
  const trials = Number(getArg("trials") ?? DEFAULT_TRIALS);
  const delayMs = Number(getArg("delay-ms") ?? DEFAULT_DELAY_MS);
  const cases = selectCases(getArgList("cases"));
  const langfuseRunName = getArg("langfuse-run") ?? `eval-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;

  const variants = (comparePaths ?? [singlePath]).map(loadVariant);

  console.log(`Cases: ${cases.map((c) => c.id).join(", ")}`);
  console.log(`Trials per case: ${trials}`);
  console.log(`Delay between requests: ${delayMs}ms (--delay-ms 0 to disable)`);
  console.log(`Langfuse run name: ${langfuseRunName} (only used if Langfuse is configured)\n`);

  const allResults: { variantName: string; results: CaseRunResult[] }[] = [];
  for (const [variantIndex, variant] of variants.entries()) {
    if (variantIndex > 0 && delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    console.log(`${"=".repeat(70)}\n${variant.name}\n${"=".repeat(70)}`);
    const results = await runSuite(variant, cases, { trials, langfuseRunName, delayMs });
    for (const result of results) {
      console.log(formatCaseResult(result));
    }
    const scored = results.filter((r): r is CaseRunResult & { meanScore: number } => r.meanScore !== null);
    const overallMean = scored.length > 0 ? scored.reduce((sum, r) => sum + r.meanScore, 0) / scored.length : null;
    console.log(`  ${"-".repeat(60)}\n  Overall mean: ${formatMeanScore(overallMean)}\n`);
    allResults.push({ variantName: variant.name, results });
  }

  if (allResults.length > 1) {
    console.log(`${"=".repeat(70)}\nSide by side\n${"=".repeat(70)}`);
    for (const testCase of cases) {
      const row = allResults
        .map((v) => {
          const r = v.results.find((res) => res.caseId === testCase.id);
          return `${v.variantName}=${r ? formatMeanScore(r.meanScore) : "?"}`;
        })
        .join("  vs  ");
      console.log(`  ${testCase.id.padEnd(45)} ${row}`);
    }
  }

  await flushTracing();
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});

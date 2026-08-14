import { createLlmClient, LlmRateLimitedError } from "../../src/agent/llm/index.js";
import { getLangfuseClient } from "../../src/agent/llm/langfuse-client.js";
import type { EvalCase, EvalAssertion, CaseRunResult, EvalTrialResult, PromptVariant, ToolCallRecord } from "./types.js";

/**
 * The engine behind `npm run test:prompts` (scripts/eval-prompt.ts). Generalizes
 * the throwaway comparison script that first proved the prompt-length regression
 * (3/3 tool calls on the old prompt, 1/3 on the new one) into something
 * permanent and reusable, rather than a one-off left in a scratch directory.
 *
 * Calls the REAL configured LLM (createLlmClient()) — no fakes, no stubbed
 * responses. That's the entire point: this measures whether the actual
 * deployed model reliably does the right thing, which a FakeLlmClient-backed
 * unit test structurally cannot answer.
 *
 * Tool dispatch is stubbed here (never OperatorTools.dispatch) — an eval run
 * must never touch real Postgres, send a real email, or create a real pending
 * deletion confirmation. Only whether the model DECIDED to call a tool is
 * being measured, not the tool's own behavior (that's what tests/unit and
 * tests/integration already cover).
 */

const DATE_SUFFIX_TEMPLATE = (now: Date): string =>
  `\n\n## Current date and time\n\nRight now it is ${now.toISOString()} (UTC) — today's date is ${now.toISOString().slice(0, 10)}. Always resolve dates the user gives you (a bare month name, "last week", "this year", a relative range) against THIS date, never against your training data or an assumed year.`;

/** A plausible canned result for a stubbed tool call, so the model can
 * continue naturally if it chains further calls in the same turn. Only
 * forget_my_data/disconnect_email get a realistic confirmationPrompt shape —
 * every other tool gets an empty object, which is fine for cases that only
 * care WHICH tool got called, not what happens after. */
function stubToolResult(toolName: string): unknown {
  if (toolName === "forget_my_data" || toolName === "disconnect_email") {
    return {
      status: "confirmation_required",
      confirmationPrompt: 'This will permanently delete your data. Reply "yes" to confirm, or anything else to cancel.',
    };
  }
  return {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

async function callOnce(variant: PromptVariant, testCase: EvalCase): Promise<EvalTrialResult> {
  const llm = createLlmClient();
  const toolsCalled: ToolCallRecord[] = [];
  const system = variant.systemPromptBase + DATE_SUFFIX_TEMPLATE(new Date());

  const responseText = await llm.completeWithTools({
    system,
    prompt: testCase.message,
    tools: variant.tools,
    history: testCase.history ?? [],
    onToolCall: async (call) => {
      toolsCalled.push({ name: call.name, input: call.input });
      return JSON.stringify(stubToolResult(call.name));
    },
  });

  return { toolsCalled, responseText };
}

/**
 * One retry on a rate limit, honouring the provider's `retryAfterSeconds` when
 * it gives one (clamped so a misbehaving header can't hang the whole run for
 * minutes). Any other failure, or a second consecutive rate limit, comes back
 * as an errored result rather than throwing — this repo's own free-tier
 * Mistral setup rate-limited mid-run during this suite's own first real test,
 * and the ORIGINAL version of this function let that single 429 kill the
 * entire suite, losing every case that hadn't run yet and printing no summary
 * at all. A rate limit is an infrastructure fact, not evidence the prompt is
 * wrong, so it must never be scored as one — see EvalTrialResult.error.
 */
async function runTrial(variant: PromptVariant, testCase: EvalCase): Promise<EvalTrialResult> {
  try {
    return await callOnce(variant, testCase);
  } catch (cause) {
    if (cause instanceof LlmRateLimitedError) {
      const delayMs = Math.min((cause.retryAfterSeconds ?? DEFAULT_RETRY_DELAY_MS / 1000) * 1000, MAX_RETRY_DELAY_MS);
      console.error(`Rate limited on ${testCase.id}, retrying once in ${Math.round(delayMs / 1000)}s...`);
      await sleep(delayMs);
      try {
        return await callOnce(variant, testCase);
      } catch (retryCause) {
        return { toolsCalled: [], responseText: "", error: String(retryCause) };
      }
    }
    return { toolsCalled: [], responseText: "", error: String(cause) };
  }
}

export interface RunCaseOptions {
  trials: number;
  /** Named experiment run for Langfuse's dataset-run comparison view — pass
   * the same name across multiple cases/variants you want grouped together in
   * one comparison (e.g. "compressed-prompt-2026-08-14"). Silently ignored
   * when Langfuse isn't configured. */
  langfuseRunName?: string;
  /**
   * Proactive pause before every trial after the first, in ms. Default 0 for
   * backward compatibility (existing callers, existing tests). Worth setting
   * on a free-tier / low-quota provider: the rate-limit retry in runTrial is
   * REACTIVE (wait after a 429), but a provider whose burst limit is tighter
   * than "one request per trial" hits that 429 on nearly every call — a real
   * 5-case, 3-trial, 2-variant run against free-tier Mistral spent most of its
   * wall-clock time retrying and still left two of ten case×variant cells
   * with zero usable trials. Pacing requests to stay under the burst window
   * in the first place is more effective than retrying after the fact.
   */
  delayMs?: number;
}

export async function runCase(variant: PromptVariant, testCase: EvalCase, options: RunCaseOptions): Promise<CaseRunResult> {
  const trials: CaseRunResult["trials"] = [];

  for (let trial = 1; trial <= options.trials; trial++) {
    if (trial > 1 && options.delayMs) {
      await sleep(options.delayMs);
    }
    const result = await runTrial(variant, testCase);
    // An errored trial gets no assertion at all — see TrialOutcome's doc
    // comment on why it must not be counted as either a pass or a fail.
    const assertion = result.error ? undefined : testCase.assert(result);
    trials.push({ trial, result, assertion });

    if (options.langfuseRunName && assertion) {
      await reportTrialToLangfuse(variant, testCase, result, assertion, options.langfuseRunName).catch((cause: unknown) => {
        // Langfuse being unreachable must never fail the eval itself — the
        // score just computed locally is still valid and still printed.
        console.error(`Langfuse reporting failed for ${testCase.id} trial ${trial}: ${String(cause)}`);
      });
    }
  }

  const scored = trials.filter((t): t is typeof t & { assertion: EvalAssertion } => t.assertion !== undefined);
  const meanScore = scored.length > 0 ? scored.reduce((sum, t) => sum + t.assertion.score, 0) / scored.length : null;
  return { caseId: testCase.id, variantName: variant.name, trials, meanScore };
}

export async function runSuite(
  variant: PromptVariant,
  cases: readonly EvalCase[],
  options: RunCaseOptions,
): Promise<CaseRunResult[]> {
  const results: CaseRunResult[] = [];
  for (const [index, testCase] of cases.entries()) {
    // Same pacing rationale as inside runCase — the burst limit doesn't reset
    // just because a new case started.
    if (index > 0 && options.delayMs) {
      await sleep(options.delayMs);
    }
    results.push(await runCase(variant, testCase, options));
  }
  return results;
}

let datasetEnsured = false;

/** Creates the dataset on first use only — createDatasetItem does NOT
 * auto-create its parent dataset (confirmed against a real project: it 404s
 * with "Dataset operator-prompt-evals not found" otherwise), unlike
 * createDatasetItem itself, which upserts. Memoized per process so a run with
 * many trials doesn't hit this endpoint every single time. */
async function ensureDatasetExists(langfuse: NonNullable<ReturnType<typeof getLangfuseClient>>): Promise<void> {
  if (datasetEnsured) {
    return;
  }
  await langfuse
    .createDataset({ name: "operator-prompt-evals", description: "src/operator/prompt.md tool-calling regression cases" })
    .catch(() => {}); // Already exists — Langfuse has no "get or create", so a repeat call is expected and harmless.
  datasetEnsured = true;
}

/**
 * Pushes one trial into Langfuse: upserts the case as a dataset item (upsert
 * is on `id`, per Langfuse's own API — safe to call every run), creates a
 * trace for this specific trial, links the dataset item to it under
 * `runName` via `createDatasetRunItem` (the direct, low-level link call —
 * NOT `getDataset(...).items[i].link(...)`, since that convenience method
 * only exists on items returned from `getDataset`'s bulk fetch; the singular
 * `getDatasetItem` returns the raw API shape without it), and scores the
 * trace. This is what makes the Langfuse UI's dataset-run comparison view
 * usable: pick two run names (e.g. one per prompt variant) and see every
 * case's score side by side.
 *
 * Deliberately bypasses agent/llm/tracing.adapter.ts's Tracer — that
 * abstraction hides the raw Langfuse client on purpose, so production code
 * (session.ts) never depends on Langfuse specifics. This runner IS
 * Langfuse-specific by design (it exists to drive Langfuse's dataset
 * feature), so it talks to the SDK directly.
 */
async function reportTrialToLangfuse(
  variant: PromptVariant,
  testCase: EvalCase,
  result: EvalTrialResult,
  assertion: EvalAssertion,
  runName: string,
): Promise<void> {
  const langfuse = getLangfuseClient();
  if (!langfuse) {
    return;
  }

  await ensureDatasetExists(langfuse);

  await langfuse.createDatasetItem({
    datasetName: "operator-prompt-evals",
    id: testCase.id,
    input: { message: testCase.message, history: testCase.history ?? [] },
    metadata: { description: testCase.description },
  });

  const trace = langfuse.trace({
    name: `eval.${testCase.id}`,
    metadata: { variant: variant.name, runName },
    tags: ["eval"],
  });
  trace
    .generation({ name: "operator.completeWithTools", input: testCase.message })
    .end({ output: result.responseText });
  trace.score({ name: "eval_score", value: assertion.score, comment: assertion.reason });

  await langfuse.createDatasetRunItem({
    runName,
    runDescription: variant.name,
    datasetItemId: testCase.id,
    traceId: trace.id,
  });
}

import type { LlmToolDefinition, LlmConversationTurn } from "../../src/agent/llm/index.js";

/**
 * CLAUDE.md §5.4's "prompt regression suite" — deliberately separate from
 * `npm test`: these call a real, configured LLM (real cost, real latency, real
 * non-determinism), so they run on demand via `npm run test:prompts`, never in
 * CI on every commit. Types shared by every case file and by the runner.
 */

/** One user message to send, plus how to score what came back. Cases are
 * sourced from real, documented incidents — a case earns its place by having
 * actually broken once, not by being a plausible thing that MIGHT break. */
export interface EvalCase {
  /** Stable across runs — used as the Langfuse dataset item id, so a case
   * renamed here silently becomes a NEW item there rather than continuing an
   * existing one's history. Keep it stable even if `description` changes. */
  id: string;
  /** What this case actually guards against — shown in run output and pushed
   * to Langfuse as the dataset item's description. */
  description: string;
  /** Prior turns, oldest first. Empty for a fresh conversation. */
  history?: LlmConversationTurn[];
  /** The message being evaluated this trial. */
  message: string;
  /** Scores one trial's outcome. Returns a 0–1 score, not a bare pass/fail —
   * the forget_my_data investigation surfaced a real "1 of 3 trials" result;
   * collapsing that to a boolean would have thrown away the signal that
   * mattered most (this isn't binary, it's UNRELIABLE). */
  assert(result: EvalTrialResult): EvalAssertion;
}

export interface EvalAssertion {
  score: number; // 0 (completely wrong) – 1 (fully correct)
  reason: string;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
}

export interface EvalTrialResult {
  toolsCalled: ToolCallRecord[];
  responseText: string;
  /**
   * Set when the LLM call itself failed (a rate limit that survived the
   * runner's retry, a network error) rather than the model producing a wrong
   * answer. Cases should not need to handle this themselves — the runner
   * excludes an errored trial from scoring rather than counting it as a hard
   * 0, since a rate limit says nothing about whether the prompt is reliable.
   */
  error?: string | undefined;
}

/** A named prompt/tools pair — what actually gets compared. Two variants
 * pointed at the SAME case set is how "is the compressed prompt as reliable
 * as the old one" gets answered with numbers instead of a vibe. */
export interface PromptVariant {
  name: string;
  /** WITHOUT the "Current date and time" suffix — the runner appends it the
   * same way session.ts's buildSystemPrompt() does, so every trial (and every
   * variant) sees a consistently-shaped prompt. */
  systemPromptBase: string;
  tools: LlmToolDefinition[];
}

export interface TrialOutcome {
  trial: number;
  result: EvalTrialResult;
  /** Undefined when the trial errored — see EvalTrialResult.error. An errored
   * trial is never scored, on either side: it isn't evidence the prompt
   * works OR that it doesn't. */
  assertion: EvalAssertion | undefined;
}

export interface CaseRunResult {
  caseId: string;
  variantName: string;
  trials: TrialOutcome[];
  /** Mean over non-errored trials only. Null when every trial for this case
   * errored — there's nothing to average, and reporting 0 would misrepresent
   * infrastructure failure as the prompt being wrong. */
  meanScore: number | null;
}

/** Common assertion builders, so most cases don't hand-roll tool-name matching. */
export const assertions = {
  /** Exactly the named tool was called (once), and nothing else. */
  calledOnly(toolName: string) {
    return (result: EvalTrialResult): EvalAssertion => {
      const names = result.toolsCalled.map((c) => c.name);
      if (names.length === 1 && names[0] === toolName) {
        return { score: 1, reason: `called ${toolName} as expected` };
      }
      if (names.includes(toolName)) {
        return { score: 0.5, reason: `called ${toolName}, but also: ${names.filter((n) => n !== toolName).join(", ")}` };
      }
      return { score: 0, reason: `expected ${toolName}, got: [${names.join(", ") || "none"}]` };
    };
  },
  /** The named tool must NEVER be called — for guarding against a forbidden action. */
  neverCalled(toolName: string) {
    return (result: EvalTrialResult): EvalAssertion => {
      const called = result.toolsCalled.some((c) => c.name === toolName);
      return called
        ? { score: 0, reason: `${toolName} was called, but must never be for this case` }
        : { score: 1, reason: `${toolName} correctly not called` };
    };
  },
  /** No tool call at all — for cases where the right answer is just a reply
   * (an ambiguous request, a question about a draft). */
  noToolCall() {
    return (result: EvalTrialResult): EvalAssertion => {
      const names = result.toolsCalled.map((c) => c.name);
      return names.length === 0
        ? { score: 1, reason: "correctly called no tool" }
        : { score: 0, reason: `expected no tool call, got: [${names.join(", ")}]` };
    };
  },
};

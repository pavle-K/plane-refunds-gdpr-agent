import { describe, it, expect } from "vitest";
import { assertions } from "../../../tests/evals/types.js";
import type { EvalTrialResult } from "../../../tests/evals/types.js";

/**
 * Pure logic only — the eval RUNNER (tests/evals/runner.ts) calls a real,
 * configured LLM and belongs to the on-demand `npm run test:prompts` suite,
 * never to `npm test`. These assertion builders have no I/O
 * at all, so there's no reason to exclude them from the fast, free, always-run
 * default suite — see vitest.config.ts's include pattern, which is scoped to
 * tests/unit/ + tests/integration/ and deliberately excludes tests/evals/.
 */

function result(names: string[]): EvalTrialResult {
  return { toolsCalled: names.map((name) => ({ name, input: {} })), responseText: "" };
}

describe("eval assertion builders", () => {
  describe("assertions.calledOnly", () => {
    const assert = assertions.calledOnly("forget_my_data");

    it("scores 1 when exactly the expected tool was called", () => {
      expect(assert(result(["forget_my_data"])).score).toBe(1);
    });

    it("scores 0 when no tool was called — the actual incident this guards against", () => {
      const outcome = assert(result([]));
      expect(outcome.score).toBe(0);
      expect(outcome.reason).toContain("none");
    });

    it("scores 0 when a different tool was called instead", () => {
      expect(assert(result(["get_claim_status"])).score).toBe(0);
    });

    it("scores partial credit when the right tool was called alongside an extra one", () => {
      const outcome = assert(result(["forget_my_data", "get_claim_status"]));
      expect(outcome.score).toBe(0.5);
      expect(outcome.reason).toContain("get_claim_status");
    });
  });

  describe("assertions.neverCalled", () => {
    const assert = assertions.neverCalled("submit_approval_decision");

    it("scores 1 when the forbidden tool was not called", () => {
      expect(assert(result(["get_claim_status"])).score).toBe(1);
    });

    it("scores 0 when the forbidden tool WAS called", () => {
      expect(assert(result(["submit_approval_decision"])).score).toBe(0);
    });
  });

  describe("assertions.noToolCall", () => {
    const assert = assertions.noToolCall();

    it("scores 1 when nothing was called", () => {
      expect(assert(result([])).score).toBe(1);
    });

    it("scores 0 when anything was called", () => {
      expect(assert(result(["get_claim_status"])).score).toBe(0);
    });
  });
});

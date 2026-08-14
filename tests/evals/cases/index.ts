import type { EvalCase } from "../types.js";
import { forgetMyDataCases } from "./forget-my-data.eval.js";
import { approvalGateCases } from "./approval-gate.eval.js";
import { multiBookingCases } from "./multi-booking.eval.js";

/**
 * Every case, in one place, for scripts/eval-prompt.ts's default run. Adding a
 * new failure mode means: add a case file next to these three, export its
 * array, list it here. Each case exists because something like it actually
 * broke once — see the doc comment at the top of each file for the incident.
 */
export const ALL_CASES: EvalCase[] = [...forgetMyDataCases, ...approvalGateCases, ...multiBookingCases];

export { forgetMyDataCases, approvalGateCases, multiBookingCases };

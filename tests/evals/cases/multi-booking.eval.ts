import type { EvalCase, EvalAssertion, EvalTrialResult } from "../types.js";

/**
 * prompt.md documents this as "a real, confirmed failure mode" and "a
 * MONEY-AFFECTING mistake" — checking several bookings together, then pulling
 * a delay/eligibility value from the wrong flight while compiling the combined
 * reply. The first place that can go wrong is upstream of the reply text
 * entirely: if start_claim isn't called once per SEPARATE booking, there's
 * nothing to correctly attribute in the first place. Phrased to explicitly
 * rule out a connecting itinerary (which correctly gets ONE call with several
 * segments) — these are two unrelated bookings.
 */

function calledStartClaimExactly(times: number) {
  return (result: EvalTrialResult): EvalAssertion => {
    const count = result.toolsCalled.filter((c) => c.name === "start_claim").length;
    if (count === times) {
      return { score: 1, reason: `called start_claim ${times} time(s) as expected` };
    }
    return {
      score: 0,
      reason: `expected start_claim called ${times} time(s), got ${count} (tools called: [${result.toolsCalled.map((c) => c.name).join(", ")}])`,
    };
  };
}

export const multiBookingCases: EvalCase[] = [
  {
    id: "multi-booking.two-separate-bookings-two-calls",
    description:
      "Two unrelated bookings must produce two start_claim calls, not one call describing both — a single " +
      "call with the wrong segments is how a compensable claim on one flight gets silently attributed to " +
      "the other's eligibility result.",
    message:
      "I have two separate bookings I'd like checked — they're different trips, different booking " +
      "references. First: flight FR725 on 2026-08-04. Second, unrelated: flight LH456 on 2026-06-15.",
    assert: calledStartClaimExactly(2),
  },
];

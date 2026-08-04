import { describe, it, expect } from "vitest";
import {
  routeAfterEligibility,
  routeAfterApproval,
  routeAfterAwaitResponse,
  routeAfterClassification,
} from "../../../../src/agent/edges/routing.js";
import { MAX_REBUTTAL_ATTEMPTS } from "../../../../src/config/constants.js";
import { buildState } from "../../../helpers/build-state.js";

describe("routeAfterEligibility", () => {
  it("routes to scoreClaim when eligible", () => {
    expect(routeAfterEligibility(buildState({ eligible: true }))).toBe("scoreClaim");
  });

  it("routes to ineligible (short-circuit) when not eligible", () => {
    expect(routeAfterEligibility(buildState({ eligible: false }))).toBe("ineligible");
  });
});

describe("routeAfterApproval", () => {
  it("routes to sendClaim only when claimStatus is 'sent'", () => {
    expect(routeAfterApproval(buildState({ claimStatus: "sent" }))).toBe("sendClaim");
  });

  it("routes to declined for any other status", () => {
    expect(routeAfterApproval(buildState({ claimStatus: "declined" }))).toBe("declined");
    expect(routeAfterApproval(buildState({ claimStatus: "pending_approval" }))).toBe("declined");
  });
});

describe("routeAfterAwaitResponse", () => {
  it("routes to classifyResponse when a reply was received", () => {
    expect(routeAfterAwaitResponse(buildState({ airlineReplyText: "some reply" }))).toBe(
      "classifyResponse",
    );
  });

  it("routes to escalate on a timeout (no reply text)", () => {
    expect(routeAfterAwaitResponse(buildState({ airlineReplyText: null }))).toBe("escalate");
  });
});

describe("routeAfterClassification", () => {
  it("routes accepted to processPayout", () => {
    const state = buildState({
      responseClassification: { category: "accepted", reasoning: "ok", requestedInfo: null },
    });
    expect(routeAfterClassification(state)).toBe("processPayout");
  });

  it("routes needs_info back to awaitResponse", () => {
    const state = buildState({
      responseClassification: { category: "needs_info", reasoning: "ok", requestedInfo: ["boarding pass"] },
    });
    expect(routeAfterClassification(state)).toBe("awaitResponse");
  });

  it("routes ambiguous to escalate", () => {
    const state = buildState({
      responseClassification: { category: "ambiguous", reasoning: "ok", requestedInfo: null },
    });
    expect(routeAfterClassification(state)).toBe("escalate");
  });

  it("routes rejected + strong evidence (not_valid_defence) to rebut", () => {
    const state = buildState({
      responseClassification: { category: "rejected", reasoning: "ok", requestedInfo: null },
      extraordinaryVerdict: "not_valid_defence",
      rebuttalCount: 0,
    });
    expect(routeAfterClassification(state)).toBe("rebut");
  });

  it("routes rejected + strong evidence (high success likelihood) to rebut", () => {
    const state = buildState({
      responseClassification: { category: "rejected", reasoning: "ok", requestedInfo: null },
      score: { successLikelihood: 0.6, confidence: 0.5, reasoning: "r", citedEvidence: [] },
      rebuttalCount: 0,
    });
    expect(routeAfterClassification(state)).toBe("rebut");
  });

  it("routes rejected + weak evidence to escalate", () => {
    const state = buildState({
      responseClassification: { category: "rejected", reasoning: "ok", requestedInfo: null },
      extraordinaryVerdict: "unproven",
      score: { successLikelihood: 0.1, confidence: 0.5, reasoning: "r", citedEvidence: [] },
      rebuttalCount: 0,
    });
    expect(routeAfterClassification(state)).toBe("escalate");
  });

  it("never rebuts past the loop bound, even with strong evidence — escalates instead", () => {
    const state = buildState({
      responseClassification: { category: "rejected", reasoning: "ok", requestedInfo: null },
      extraordinaryVerdict: "not_valid_defence",
      rebuttalCount: MAX_REBUTTAL_ATTEMPTS,
    });
    expect(routeAfterClassification(state)).toBe("escalate");
  });
});

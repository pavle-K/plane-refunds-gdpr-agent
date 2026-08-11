import type { GraphStateType } from "../../src/agent/state.js";

export function buildState(overrides: Partial<GraphStateType> = {}): GraphStateType {
  return {
    claimId: "claim-1",
    claimStatus: "draft",
    rawEmailText: null,
    booking: null,
    flightStatuses: [],
    eligible: null,
    eligibilityReason: null,
    compensationCents: null,
    causeCode: null,
    extraordinaryVerdict: null,
    weatherObservation: null,
    disruptionEvents: [],
    score: null,
    draftText: null,
    submissionWarning: null,
    approvalDecision: null,
    approvedText: null,
    sendReceipt: null,
    airlineReplyText: null,
    responseClassification: null,
    rebuttalCount: 0,
    escalationReason: null,
    receivedAmountCents: null,
    connectedAccountId: null,
    payout: null,
    ...overrides,
  };
}

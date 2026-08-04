import type { GraphStateType } from "../state.js";
import { MAX_REBUTTAL_ATTEMPTS } from "../../config/constants.js";

export type EligibilityRoute = "scoreClaim" | "ineligible";

/** Ineligible flights never reach drafting — short-circuit immediately (§5.5). */
export function routeAfterEligibility(state: GraphStateType): EligibilityRoute {
  return state.eligible ? "scoreClaim" : "ineligible";
}

export type ApprovalRoute = "sendClaim" | "declined";

/** Only claimStatus === "sent" (set exclusively by human-approval.node.ts on
 * approve/edit) proceeds to sendClaim — decline routes to the terminal end. */
export function routeAfterApproval(state: GraphStateType): ApprovalRoute {
  return state.claimStatus === "sent" ? "sendClaim" : "declined";
}

export type ResponseRoute = "processPayout" | "awaitResponse" | "rebut" | "escalate";

function hasStrongRebuttalEvidence(state: GraphStateType): boolean {
  if (state.extraordinaryVerdict === "not_valid_defence") {
    return true;
  }
  if (state.score !== null && state.score.successLikelihood >= 0.4) {
    return true;
  }
  return false;
}

/**
 * accepted → payout; needs_info → keep waiting; ambiguous → flag for a human;
 * rejected → rebut only with strong evidence AND attempts remaining, otherwise
 * escalate. This is the loop-bound enforcement: rebuttalCount is checked here, not
 * inside rebut.node.ts, so the limit is provably a single source of truth (§5.3).
 */
export function routeAfterClassification(state: GraphStateType): ResponseRoute {
  const category = state.responseClassification?.category;

  if (category === "accepted") {
    return "processPayout";
  }
  if (category === "needs_info") {
    return "awaitResponse";
  }
  if (category === "ambiguous") {
    return "escalate";
  }

  // category === "rejected" (or classification missing — treat conservatively as escalate)
  if (category !== "rejected") {
    return "escalate";
  }
  if (state.rebuttalCount >= MAX_REBUTTAL_ATTEMPTS) {
    return "escalate";
  }
  if (!hasStrongRebuttalEvidence(state)) {
    return "escalate";
  }
  return "rebut";
}

export type AwaitResponseRoute = "classifyResponse" | "escalate";

/** A timed-out wait (no reply text) skips classification and escalates directly. */
export function routeAfterAwaitResponse(state: GraphStateType): AwaitResponseRoute {
  return state.airlineReplyText ? "classifyResponse" : "escalate";
}

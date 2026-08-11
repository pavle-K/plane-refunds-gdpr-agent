import { Annotation } from "@langchain/langgraph";
import type { Booking, ClaimStatus } from "../domain/claim/claim.types.js";
import type { ExtraordinaryCauseCode, ExtraordinaryVerdict } from "../domain/ec261/extraordinary.js";
import type { FlightStatusResult } from "../providers/flight-status/flight-status.port.js";
import type { WeatherObservation } from "../providers/weather/weather.port.js";
import type { DisruptionEvent } from "../providers/disruption/disruption.port.js";

export interface ClaimScore {
  successLikelihood: number;
  confidence: number;
  reasoning: string;
  citedEvidence: string[];
}

export type ApprovalDecision = "approved" | "edited" | "declined";

export interface SendReceipt {
  messageId: string;
  sentAtUtc: string;
}

export type ResponseCategory = "accepted" | "rejected" | "needs_info" | "ambiguous";

export interface ResponseClassification {
  category: ResponseCategory;
  reasoning: string;
  requestedInfo: string[] | null;
}

export interface PayoutOutcome {
  commissionCents: number;
  payoutCents: number;
  transferId: string;
}

function overwrite<T>(defaultValue: T) {
  return { reducer: (_current: T, update: T): T => update, default: (): T => defaultValue };
}

export const GraphState = Annotation.Root({
  claimId: Annotation<string>(overwrite("")),
  claimStatus: Annotation<ClaimStatus>(overwrite<ClaimStatus>("draft")),

  /** Raw email body, when the graph is invoked from an inbox rather than an upload. */
  rawEmailText: Annotation<string | null>(overwrite<string | null>(null)),
  booking: Annotation<Booking | null>(overwrite<Booking | null>(null)),

  /** One entry per booking.segments[], same order. First = first departure, last = final arrival. */
  flightStatuses: Annotation<FlightStatusResult[]>(overwrite<FlightStatusResult[]>([])),
  eligible: Annotation<boolean | null>(overwrite<boolean | null>(null)),
  eligibilityReason: Annotation<string | null>(overwrite<string | null>(null)),
  compensationCents: Annotation<number | null>(overwrite<number | null>(null)),

  causeCode: Annotation<ExtraordinaryCauseCode | null>(overwrite<ExtraordinaryCauseCode | null>(null)),
  extraordinaryVerdict: Annotation<ExtraordinaryVerdict | null>(overwrite<ExtraordinaryVerdict | null>(null)),
  weatherObservation: Annotation<WeatherObservation | null>(overwrite<WeatherObservation | null>(null)),
  disruptionEvents: Annotation<DisruptionEvent[]>(overwrite<DisruptionEvent[]>([])),

  score: Annotation<ClaimScore | null>(overwrite<ClaimScore | null>(null)),

  draftText: Annotation<string | null>(overwrite<string | null>(null)),
  /** Non-null when the operating carrier's ClaimSubmissionMethod isn't
   * "email" (web_form, unsupported, or no directory entry at all) — set by
   * draftClaim so the operator can tell the human BEFORE asking for approval
   * that this claim currently has no automated send path. sendClaim enforces
   * the actual refusal independently; this is purely informational. */
  submissionWarning: Annotation<string | null>(overwrite<string | null>(null)),
  approvalDecision: Annotation<ApprovalDecision | null>(overwrite<ApprovalDecision | null>(null)),
  approvedText: Annotation<string | null>(overwrite<string | null>(null)),

  sendReceipt: Annotation<SendReceipt | null>(overwrite<SendReceipt | null>(null)),

  airlineReplyText: Annotation<string | null>(overwrite<string | null>(null)),
  responseClassification: Annotation<ResponseClassification | null>(
    overwrite<ResponseClassification | null>(null),
  ),

  rebuttalCount: Annotation<number>(overwrite(0)),
  escalationReason: Annotation<string | null>(overwrite<string | null>(null)),

  receivedAmountCents: Annotation<number | null>(overwrite<number | null>(null)),
  /** Stripe Connect account id to pay out to — resolved externally (no user/Stripe
   * account linkage exists yet; this is supplied at invocation, not derived here). */
  connectedAccountId: Annotation<string | null>(overwrite<string | null>(null)),
  payout: Annotation<PayoutOutcome | null>(overwrite<PayoutOutcome | null>(null)),
});

export type GraphStateType = typeof GraphState.State;

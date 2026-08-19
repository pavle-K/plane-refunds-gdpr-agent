/**
 * Mirrors the backend's own types (src/domain/claim/claim.types.ts,
 * src/providers/airline-directory/submission-plan.ts, src/agent/state.ts) as
 * seen through the JSON responses of /api/web/*. Kept as a hand-written
 * mirror rather than a shared package: this app never imports backend
 * source (see package.json's own description) — the backend is a network
 * boundary, not a monorepo package, so its types are re-declared here at
 * that boundary like any other external API contract.
 */

export type ClaimStatus =
  | "draft"
  | "pending_approval"
  | "declined"
  | "sent"
  | "needs_manual_submission"
  | "awaiting_response"
  | "rejected"
  | "rebutting"
  | "escalated"
  | "accepted"
  | "paid";

export interface Passenger {
  id: string;
  fullName: string | null;
  email: string | null;
}

export interface FlightSegment {
  flightNumber: string;
  operatingCarrierCode: string;
  departureAirportIata?: string;
  arrivalAirportIata?: string;
  scheduledDepartureUtc: string;
  scheduledArrivalUtc: string;
}

export interface Booking {
  bookingReference: string;
  passengers: Passenger[];
  segments: FlightSegment[];
}

export type VerificationStatus = "verified" | "partially_verified" | "unverified";
export type ThirdPartySubmissionPolicy = "allowed" | "requires_authorization" | "restricted";
export type ClaimChannelKind = "web_form" | "email" | "postal";

export interface PresentableChannel {
  id: string;
  kind: ClaimChannelKind;
  label: string;
  verification: VerificationStatus;
  url?: string;
  emailAddress?: string;
  postalAddress?: string[];
  requiredFieldLabels: string[] | null;
  guidance: string[];
}

export type ChannelSelection =
  | { type: "single"; channel: unknown }
  | { type: "choice_required"; options: unknown[] }
  | { type: "none_available"; reason: "carrier_not_in_directory" | "no_channel_recorded" | "only_unverified_channels" };

export interface SubmissionPlan {
  carrierIataCode: string;
  carrierName: string | null;
  thirdPartySubmission: ThirdPartySubmissionPolicy | null;
  selection: ChannelSelection;
  channels: PresentableChannel[];
  message: string;
  /** Non-null ONLY when this claim can actually be dispatched automatically
   * — see src/providers/airline-directory/submission-plan.ts's identical
   * field. Approving a claim without this still just records your decision;
   * the system can't send anything for it, and the airline tab's channel
   * info is what you act on yourself. */
  autoSendChannel: unknown | null;
}

export interface PayoutOutcome {
  commissionCents: number;
  payoutCents: number;
  transferId: string;
}

/** Matches OperatorTools.getClaimStatus's return shape exactly
 * (src/operator/tools.ts). */
export interface ClaimDetail {
  threadId: string;
  claimStatus: ClaimStatus;
  awaitingInput: boolean;
  pausedOn: string | null;
  eligible: boolean | null;
  eligibilityReason: string | null;
  compensationCents: number | null;
  draftText: string | null;
  submission: SubmissionPlan | null;
  escalationReason: string | null;
  payout: PayoutOutcome | null;
  booking: Booking | null;
}

/** GET /api/web/claims' per-row shape — ClaimDetail plus the ownership-mirror
 * fields claims.routes.ts merges on from ClaimRepo (src/db/repositories/claim.repo.ts). */
export interface ClaimSummary extends ClaimDetail {
  bookingReference: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface ClaimsListResponse {
  claims: ClaimSummary[];
}

export type ApprovalAction = "approve" | "edit" | "decline";

export interface PostalPackResult {
  generated?: true;
  postalAddress?: string[];
  deliveredTo?: string[];
  failed?: string[];
  outstandingFields?: string[];
  error?: string;
}

export interface PassengerProfileResponse {
  saved: boolean;
  fullName?: string | null;
  contactEmail?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  countryIsoCode?: string | null;
  hasIban?: boolean;
  hasBic?: boolean;
  missing: string[];
  error?: string;
}

export interface SavePassengerProfileInput {
  fullName?: string;
  contactEmail?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postalCode?: string;
  countryIsoCode?: string;
  iban?: string;
  bic?: string;
}

export interface EmailConnectionStatus {
  connected: boolean;
  emailAddress?: string;
}

export interface EmailConnectionsResponse {
  gmail: EmailConnectionStatus;
  outlook: EmailConnectionStatus;
}

export interface ChatTurn {
  /** "system" is a backend-injected turn (e.g. the note that resumes a
   * conversation once a connected inbox finishes OAuth) — never something
   * the user actually typed. See src/db/repositories/conversation.repo.ts's
   * ConversationTurn doc comment. The chat UI should never render one of
   * these as if it came from the user. */
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatHistoryResponse {
  turns: ChatTurn[];
}

export type WebAction = { type: "oauth_popup"; provider: "gmail" | "outlook"; authorizationUrl: string };

export interface SendMessageResponse {
  reply: string;
  actions: WebAction[];
}

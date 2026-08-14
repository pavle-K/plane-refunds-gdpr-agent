import type { GraphStateType } from "../state.js";
import type { EmailSendProvider } from "../../providers/email-send/email-send.port.js";
import type { AirlineDirectoryProvider, ClaimSubmissionMethod } from "../../providers/airline-directory/airline-directory.port.js";
import type { AuditLog } from "../../compliance/audit-log.js";

export interface SendClaimNodeDeps {
  emailSend: EmailSendProvider;
  airlineDirectory: AirlineDirectoryProvider;
  auditLog: AuditLog;
  /** Sender address for outbound claims, from CLAIM_SENDER_EMAIL (see
   * src/agent/real-deps.ts). Optional on the type so tests and the fake-wired
   * scripts can construct deps without it — but a send with no configured
   * sender is refused outright rather than defaulted, see
   * MissingSenderAddressError. */
  fromAddress?: string;
}

export class ClaimNotApprovedError extends Error {
  constructor(status: string) {
    super(`sendClaim refused: claim status is "${status}", not "sent" (approval gate not passed)`);
    this.name = "ClaimNotApprovedError";
  }
}

/**
 * There used to be a hardcoded "claims@example.com" fallback here. A claim
 * letter is a legal document; sending one from an address this project doesn't
 * own means the airline's reply goes nowhere and the passenger has no record of
 * having filed — a silent, hard-to-detect failure. Refusing is strictly better
 * than a placeholder that looks like it worked. Set CLAIM_SENDER_EMAIL.
 */
export class MissingSenderAddressError extends Error {
  constructor() {
    super("sendClaim refused: no sender address configured (set CLAIM_SENDER_EMAIL).");
    this.name = "MissingSenderAddressError";
  }
}

/**
 * Defense in depth, same spirit as ClaimNotApprovedError: draft-claim.node.ts
 * already surfaces a submissionWarning to the human before approval for a
 * non-"email" carrier, but this node refuses independently regardless of
 * whether that warning was shown or heeded — approval alone must never be
 * enough to make this node attempt something it can't actually do. "web_form"
 * carriers aren't automated yet (see the self-updating-submission-agent
 * GitHub issue); "unsupported" carriers have no sourced channel at all.
 */
export class ClaimSubmissionNotAutomatedError extends Error {
  constructor(carrierName: string, method: ClaimSubmissionMethod) {
    super(
      method.type === "web_form"
        ? `sendClaim refused: ${carrierName} requires manual web-form submission (${method.formUrl}) — not automated yet.`
        : method.type === "unsupported"
          ? `sendClaim refused: no sourced/verified submission channel for ${carrierName} yet (${method.reason}).`
          : `sendClaim refused: ${carrierName}'s submission method is not "email".`,
    );
    this.name = "ClaimSubmissionNotAutomatedError";
  }
}

/**
 * Defense in depth: refuses to send unless the claim already passed through the
 * approval gate (claimStatus === "sent", which only human-approval.node can set).
 * The graph's edges should never route here otherwise, but this node checks
 * anyway — see CLAUDE.md's non-negotiable on enforcing this at both levels.
 */
export function createSendClaimNode(deps: SendClaimNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (state.claimStatus !== "sent") {
      throw new ClaimNotApprovedError(state.claimStatus);
    }
    if (!state.booking || !state.approvedText) {
      throw new Error("sendClaim: missing booking or approvedText");
    }

    // Sent to the LAST segment's operating carrier, matching the carrier used
    // for the Article 3(1)(b) coverage test in check-eligibility.node.ts. For a
    // multi-carrier connecting itinerary, which carrier is actually liable is a
    // genuinely nuanced legal question (see eligibility.ts's comment on this) —
    // this is a simplification, not a settled answer.
    const lastSegment = state.booking.segments[state.booking.segments.length - 1];
    if (!lastSegment) {
      throw new Error("sendClaim: booking has no segments");
    }

    // Prefer the carrier the flight-status lookup actually reported, falling
    // back to the booking's own code only when no status was resolved. This
    // MUST match what check-eligibility.node.ts and draft-claim.node.ts used —
    // they both read flightStatuses[last].operatingCarrierIataCode, while the
    // booking's operatingCarrierCode is often just the flight number's 2-letter
    // prefix (see OperatorTools.startClaim). On a codeshare those disagree
    // (BA1234 operated by Iberia: AeroAPI reports "IB", the prefix says "BA"),
    // and disagreeing here meant draftClaim could compute submissionWarning for
    // one carrier while this node resolved a different one — reopening the
    // "status says sent but nothing was dispatched" bug from the other side.
    const lastFlightStatus = state.flightStatuses[state.flightStatuses.length - 1];
    const carrierCode = lastFlightStatus?.operatingCarrierIataCode ?? lastSegment.operatingCarrierCode;

    const airlineResult = await deps.airlineDirectory.getAirline(carrierCode);
    if (!airlineResult.ok) {
      throw new Error(`sendClaim: no airline directory entry for ${carrierCode}`);
    }

    const { submissionMethod, carrierName } = airlineResult.value;
    if (submissionMethod.type !== "email") {
      throw new ClaimSubmissionNotAutomatedError(carrierName, submissionMethod);
    }

    if (!deps.fromAddress) {
      throw new MissingSenderAddressError();
    }

    const flightNumbers = state.booking.segments.map((s) => s.flightNumber).join("/");
    const result = await deps.emailSend.send({
      to: submissionMethod.claimsEmail,
      from: deps.fromAddress,
      subject: `EC261 Compensation Claim — ${flightNumbers} — ${state.booking.bookingReference}`,
      textBody: state.approvedText,
    });

    if (!result.ok) {
      throw new Error(`sendClaim: send failed (${result.error.type}): ${result.error.message}`);
    }

    await deps.auditLog.record({
      claimId: state.claimId,
      entryType: "system_action",
      payload: { node: "sendClaim", to: submissionMethod.claimsEmail, messageId: result.value.messageId },
    });

    return { sendReceipt: result.value };
  };
}

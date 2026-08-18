import type { GraphStateType } from "../state.js";
import type { EmailSendProvider } from "../../providers/email-send/email-send.port.js";
import type { AirlineDirectoryProvider } from "../../providers/airline-directory/airline-directory.port.js";
import { buildSubmissionPlan } from "../../providers/airline-directory/submission-plan.js";
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
 * already tells the human before approval whether this carrier can be dispatched
 * to, but this node refuses independently regardless of whether that was shown
 * or heeded — approval alone must never be enough to make this node attempt
 * something it cannot actually do.
 *
 * A carrier has no auto-send channel when it accepts only a web form (not
 * automated yet — see the self-updating-submission-agent GitHub issue), when its
 * only address is unverified, when its only email address is a PEC legal mailbox
 * rather than a claims desk, or when the carrier refuses third-party submissions
 * outright. buildSubmissionPlan makes that judgement once; this node does not
 * second-guess it.
 */
export class ClaimSubmissionNotAutomatedError extends Error {
  constructor(carrierName: string | null, detail: string) {
    super(`sendClaim refused: ${carrierName ?? "this carrier"} has no automated submission channel — ${detail}.`);
    this.name = "ClaimSubmissionNotAutomatedError";
  }
}

/**
 * Defense in depth: refuses to send unless the claim already passed through the
 * approval gate (claimStatus === "sent", which only human-approval.node can set).
 * The graph's edges should never route here otherwise, but this node checks
 * anyway — this is enforced at both levels, deliberately, as defense in depth.
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
    // and disagreeing here meant draftClaim could build a submission plan for
    // one carrier while this node resolved a different one — reopening the
    // "status says sent but nothing was dispatched" bug from the other side.
    const lastFlightStatus = state.flightStatuses[state.flightStatuses.length - 1];
    const carrierCode = lastFlightStatus?.operatingCarrierIataCode ?? lastSegment.operatingCarrierCode;

    // One definition of "can this actually be dispatched", shared with
    // human-approval via state.submission — see buildSubmissionPlan.
    const plan = buildSubmissionPlan(carrierCode, await deps.airlineDirectory.getAirline(carrierCode));
    const autoSendChannel = plan.autoSendChannel;
    if (!autoSendChannel) {
      throw new ClaimSubmissionNotAutomatedError(
        plan.carrierName,
        plan.selection.type === "none_available"
          ? `no usable channel (${plan.selection.reason})`
          : "its channels all need a human to submit them",
      );
    }

    if (!deps.fromAddress) {
      throw new MissingSenderAddressError();
    }

    const flightNumbers = state.booking.segments.map((s) => s.flightNumber).join("/");
    const result = await deps.emailSend.send({
      to: autoSendChannel.address,
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
      payload: { node: "sendClaim", to: autoSendChannel.address, messageId: result.value.messageId },
    });

    return { sendReceipt: result.value };
  };
}

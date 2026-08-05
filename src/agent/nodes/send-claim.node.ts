import type { GraphStateType } from "../state.js";
import type { EmailSendProvider } from "../../providers/email-send/email-send.port.js";
import type { AirlineDirectoryProvider } from "../../providers/airline-directory/airline-directory.port.js";
import type { AuditLog } from "../../compliance/audit-log.js";

export interface SendClaimNodeDeps {
  emailSend: EmailSendProvider;
  airlineDirectory: AirlineDirectoryProvider;
  auditLog: AuditLog;
  /** Sender address for outbound claims — TODO: real sending domain once configured. */
  fromAddress?: string;
}

export class ClaimNotApprovedError extends Error {
  constructor(status: string) {
    super(`sendClaim refused: claim status is "${status}", not "sent" (approval gate not passed)`);
    this.name = "ClaimNotApprovedError";
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

    const airlineResult = await deps.airlineDirectory.getAirline(lastSegment.operatingCarrierCode);
    if (!airlineResult.ok) {
      throw new Error(`sendClaim: no airline directory entry for ${lastSegment.operatingCarrierCode}`);
    }

    const flightNumbers = state.booking.segments.map((s) => s.flightNumber).join("/");
    const result = await deps.emailSend.send({
      to: airlineResult.value.claimsEmail,
      from: deps.fromAddress ?? "claims@example.com",
      subject: `EC261 Compensation Claim — ${flightNumbers} — ${state.booking.bookingReference}`,
      textBody: state.approvedText,
    });

    if (!result.ok) {
      throw new Error(`sendClaim: send failed (${result.error.type}): ${result.error.message}`);
    }

    await deps.auditLog.record({
      claimId: state.claimId,
      entryType: "system_action",
      payload: { node: "sendClaim", to: airlineResult.value.claimsEmail, messageId: result.value.messageId },
    });

    return { sendReceipt: result.value };
  };
}

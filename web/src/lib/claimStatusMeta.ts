import type { ClaimStatus } from "../api/types.js";

interface StatusMeta {
  label: string;
  color: string;
  description: string;
}

/** One entry per ClaimStatus — kept in sync with
 * src/domain/claim/state-machine.ts's TRANSITIONS table (the source of
 * truth for which statuses exist and how they connect). */
export const CLAIM_STATUS_META: Record<ClaimStatus, StatusMeta> = {
  draft: {
    label: "Drafting",
    color: "var(--text-secondary)",
    description: "Checking eligibility and preparing the claim.",
  },
  pending_approval: {
    label: "Awaiting your approval",
    color: "var(--warning)",
    description: "A drafted claim is ready — review it in chat before it goes anywhere.",
  },
  declined: {
    label: "Declined",
    color: "var(--text-secondary)",
    description: "You declined this draft. Nothing was sent.",
  },
  sent: {
    label: "Sent",
    color: "var(--accent)",
    description: "The claim was dispatched to the airline.",
  },
  needs_manual_submission: {
    label: "Needs manual submission",
    color: "var(--warning)",
    description: "Approved, but this airline has no automated channel — you'll need to submit it yourself.",
  },
  awaiting_response: {
    label: "Awaiting the airline's response",
    color: "var(--accent)",
    description: "Sent — waiting to hear back.",
  },
  rejected: {
    label: "Rejected",
    color: "var(--danger)",
    description: "The airline rejected the claim. It may be worth a rebuttal.",
  },
  rebutting: {
    label: "Rebutting",
    color: "var(--warning)",
    description: "Preparing a counter-argument to the airline's rejection.",
  },
  escalated: {
    label: "Escalated",
    color: "var(--danger)",
    description: "This needs manual/legal follow-up beyond what the assistant can do.",
  },
  accepted: {
    label: "Accepted",
    color: "var(--success)",
    description: "The airline accepted the claim — waiting on payment.",
  },
  paid: {
    label: "Paid",
    color: "var(--success)",
    description: "Paid out, commission deducted.",
  },
};

/** The straight-line path a claim takes when nothing goes wrong — used by
 * StatusTimeline to render progress dots. Off-path statuses (declined,
 * rejected, rebutting, escalated, needs_manual_submission) still map onto a
 * position via OFF_PATH_BRANCH_POINT below, showing how far the claim got
 * before it diverged. */
export const HAPPY_PATH_STATUSES: ClaimStatus[] = ["draft", "pending_approval", "sent", "awaiting_response", "accepted", "paid"];

export const OFF_PATH_BRANCH_POINT: Partial<Record<ClaimStatus, number>> = {
  declined: 1,
  needs_manual_submission: 1,
  rejected: 3,
  rebutting: 3,
  escalated: 3,
};

/**
 * "pending_approval" and "awaiting_response" describe a WAIT, and are never
 * actually the claim's stored status while that wait is happening — see
 * src/agent/nodes/human-approval.node.ts and await-response.node.ts: each
 * one computes what status comes NEXT, then calls interrupt(), which pauses
 * by throwing before that computed value is ever returned/checkpointed. So
 * while paused, the real stored claimStatus is still whatever the PRECEDING
 * node left it as ("draft" before human approval, "sent" before an airline
 * reply) — the only reliable "is this actually waiting on something right
 * now" signal is awaitingInput/pausedOn (from get_claim_status), not
 * claimStatus itself. This maps (claimStatus, pausedOn) onto the status the
 * UI actually has copy for, so every other display in this app can keep
 * working directly off a single ClaimStatus value. */
export function effectiveDisplayStatus(claim: { claimStatus: ClaimStatus; awaitingInput: boolean; pausedOn: string | null }): ClaimStatus {
  if (claim.awaitingInput) {
    if (claim.pausedOn === "humanApproval") return "pending_approval";
    if (claim.pausedOn === "awaitResponse") return "awaiting_response";
  }
  return claim.claimStatus;
}

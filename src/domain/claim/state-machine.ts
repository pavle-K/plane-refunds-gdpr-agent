import type { ClaimStatus } from "./claim.types.js";

/**
 * Legal status transitions for a claim. The rebuttal loop reuses
 * pending_approval → sent → awaiting_response rather than duplicating that chain,
 * so a rebuttal draft passes through the exact same human-approval gate as the
 * original claim — there is no event that reaches "sent" except from
 * "pending_approval", and no event that reaches "paid" except from "accepted".
 */
export type ClaimEvent =
  | "SUBMIT_FOR_APPROVAL"
  | "REQUEST_EDIT"
  | "DECLINE"
  | "SEND"
  | "CANNOT_AUTO_SEND"
  | "CONFIRM_DISPATCHED"
  | "RECEIVE_REJECTION"
  | "RECEIVE_ACCEPTANCE"
  | "TIMEOUT"
  | "REBUT"
  | "ESCALATE"
  | "CONFIRM_PAYOUT";

export class IllegalTransitionError extends Error {
  constructor(status: ClaimStatus, event: ClaimEvent) {
    super(`Illegal transition: event "${event}" is not valid from status "${status}"`);
    this.name = "IllegalTransitionError";
  }
}

type TransitionTable = {
  readonly [S in ClaimStatus]: Partial<Record<ClaimEvent, ClaimStatus>>;
};

const TRANSITIONS: TransitionTable = {
  draft: {
    SUBMIT_FOR_APPROVAL: "pending_approval",
  },
  pending_approval: {
    REQUEST_EDIT: "draft",
    DECLINE: "declined",
    SEND: "sent",
    // Human approved the CONTENT, but this carrier has no automated
    // submission channel (see human-approval.node.ts) — distinct from "sent"
    // (this system dispatched nothing) and from "declined" (the human didn't
    // reject it). Terminal: tracking what happens after a human submits it
    // themselves is deliberately out of scope for now.
    CANNOT_AUTO_SEND: "needs_manual_submission",
  },
  declined: {},
  needs_manual_submission: {},
  sent: {
    CONFIRM_DISPATCHED: "awaiting_response",
  },
  awaiting_response: {
    RECEIVE_REJECTION: "rejected",
    RECEIVE_ACCEPTANCE: "accepted",
    TIMEOUT: "escalated",
  },
  rejected: {
    REBUT: "rebutting",
    ESCALATE: "escalated",
  },
  rebutting: {
    SUBMIT_FOR_APPROVAL: "pending_approval",
    DECLINE: "declined",
  },
  escalated: {},
  accepted: {
    CONFIRM_PAYOUT: "paid",
  },
  paid: {},
};

const TERMINAL_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  "declined",
  "needs_manual_submission",
  "escalated",
  "paid",
]);

export function isTerminal(status: ClaimStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(status: ClaimStatus, event: ClaimEvent): boolean {
  return TRANSITIONS[status][event] !== undefined;
}

export function applyTransition(status: ClaimStatus, event: ClaimEvent): ClaimStatus {
  const next = TRANSITIONS[status][event];
  if (next === undefined) {
    throw new IllegalTransitionError(status, event);
  }
  return next;
}

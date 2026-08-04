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
  },
  declined: {},
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

const TERMINAL_STATUSES: ReadonlySet<ClaimStatus> = new Set(["declined", "escalated", "paid"]);

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

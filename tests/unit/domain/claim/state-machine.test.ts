import { describe, it, expect } from "vitest";
import {
  applyTransition,
  canTransition,
  isTerminal,
  IllegalTransitionError,
} from "../../../../src/domain/claim/state-machine.js";
import type { ClaimStatus } from "../../../../src/domain/claim/claim.types.js";

describe("claim state machine — legal transitions", () => {
  it("walks the full happy path, including a rebuttal loop back through approval", () => {
    let status: ClaimStatus = "draft";
    status = applyTransition(status, "SUBMIT_FOR_APPROVAL");
    expect(status).toBe("pending_approval");
    status = applyTransition(status, "SEND");
    expect(status).toBe("sent");
    status = applyTransition(status, "CONFIRM_DISPATCHED");
    expect(status).toBe("awaiting_response");
    status = applyTransition(status, "RECEIVE_REJECTION");
    expect(status).toBe("rejected");
    status = applyTransition(status, "REBUT");
    expect(status).toBe("rebutting");
    status = applyTransition(status, "SUBMIT_FOR_APPROVAL");
    expect(status).toBe("pending_approval");
    status = applyTransition(status, "SEND");
    expect(status).toBe("sent");
    status = applyTransition(status, "CONFIRM_DISPATCHED");
    expect(status).toBe("awaiting_response");
    status = applyTransition(status, "RECEIVE_ACCEPTANCE");
    expect(status).toBe("accepted");
    status = applyTransition(status, "CONFIRM_PAYOUT");
    expect(status).toBe("paid");
  });

  it("allows an approver to request edits, looping back to draft", () => {
    const status = applyTransition("pending_approval", "REQUEST_EDIT");
    expect(status).toBe("draft");
  });

  it("allows declining at the approval gate, before or after a rebuttal", () => {
    expect(applyTransition("pending_approval", "DECLINE")).toBe("declined");
    expect(applyTransition("rebutting", "DECLINE")).toBe("declined");
  });

  it("allows CANNOT_AUTO_SEND at the approval gate for a carrier with no automated send path", () => {
    expect(applyTransition("pending_approval", "CANNOT_AUTO_SEND")).toBe("needs_manual_submission");
  });

  it("allows escalation on timeout or on a weak rebuttal case", () => {
    expect(applyTransition("awaiting_response", "TIMEOUT")).toBe("escalated");
    expect(applyTransition("rejected", "ESCALATE")).toBe("escalated");
  });
});

describe("claim state machine — illegal transitions", () => {
  it("rejects draft → sent directly, since that would bypass human approval", () => {
    expect(() => applyTransition("draft", "SEND")).toThrow(IllegalTransitionError);
    expect(canTransition("draft", "SEND")).toBe(false);
  });

  it("rejects any transition into paid that did not pass through a confirmed payout", () => {
    const nonAcceptedStatuses: ClaimStatus[] = [
      "draft",
      "pending_approval",
      "sent",
      "needs_manual_submission",
      "awaiting_response",
      "rejected",
      "rebutting",
      "declined",
      "escalated",
    ];
    for (const status of nonAcceptedStatuses) {
      expect(canTransition(status, "CONFIRM_PAYOUT")).toBe(false);
      expect(() => applyTransition(status, "CONFIRM_PAYOUT")).toThrow(IllegalTransitionError);
    }
  });

  it("rejects events that skip steps (e.g. sending straight to accepted)", () => {
    expect(() => applyTransition("sent", "RECEIVE_ACCEPTANCE")).toThrow(IllegalTransitionError);
  });
});

describe("claim state machine — terminal states", () => {
  it.each(["declined", "needs_manual_submission", "escalated", "paid"] as const)(
    "accepts no further transitions from %s",
    (status) => {
      expect(isTerminal(status)).toBe(true);
      const allEvents = [
        "SUBMIT_FOR_APPROVAL",
        "REQUEST_EDIT",
        "DECLINE",
        "SEND",
        "CANNOT_AUTO_SEND",
        "CONFIRM_DISPATCHED",
        "RECEIVE_REJECTION",
        "RECEIVE_ACCEPTANCE",
        "TIMEOUT",
        "REBUT",
        "ESCALATE",
        "CONFIRM_PAYOUT",
      ] as const;
      for (const event of allEvents) {
        expect(canTransition(status, event)).toBe(false);
      }
    },
  );

  it("does not consider active statuses terminal", () => {
    const activeStatuses: ClaimStatus[] = [
      "draft",
      "pending_approval",
      "sent",
      "awaiting_response",
      "rejected",
      "rebutting",
      "accepted",
    ];
    for (const status of activeStatuses) {
      expect(isTerminal(status)).toBe(false);
    }
  });
});

describe("claim state machine — idempotency", () => {
  it("does not double-advance when the same event is replayed against the already-advanced status", () => {
    const advanced = applyTransition("sent", "CONFIRM_DISPATCHED");
    expect(advanced).toBe("awaiting_response");

    // Replaying CONFIRM_DISPATCHED again (e.g. a duplicate webhook) must not silently
    // advance further — "awaiting_response" has no CONFIRM_DISPATCHED transition.
    expect(() => applyTransition(advanced, "CONFIRM_DISPATCHED")).toThrow(
      IllegalTransitionError,
    );
  });

  it("applying the same (status, event) pair repeatedly is deterministic", () => {
    const first = applyTransition("draft", "SUBMIT_FOR_APPROVAL");
    const second = applyTransition("draft", "SUBMIT_FOR_APPROVAL");
    expect(first).toBe(second);
  });
});

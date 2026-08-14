import { interrupt } from "@langchain/langgraph";
import type { GraphStateType } from "../state.js";
import type { AuditLog } from "../../compliance/audit-log.js";
import { applyTransition } from "../../domain/claim/state-machine.js";

export interface HumanApprovalDecision {
  action: "approve" | "edit" | "decline";
  /** Required when action is "edit" — the human's own edited text, sent verbatim. */
  editedText?: string;
}

export interface HumanApprovalPayload {
  claimId: string;
  draftText: string | null;
}

export interface HumanApprovalNodeDeps {
  auditLog: AuditLog;
}

/**
 * The mandatory pause before any outbound send (CLAUDE.md §Stage 2 non-negotiable).
 * Interrupts the graph and waits for a human decision delivered via
 * `Command({ resume: decision })`. "edit" proceeds with the human's own text, not
 * the original draft — approve and edit both reach "sent" IF this carrier actually
 * has an automated send path.
 *
 * `state.submission` (set by draftClaim) is already known at this point. Its
 * `autoSendChannel` is the single definition of "this can actually be
 * dispatched", shared with sendClaim so the two cannot disagree. When it is
 * null, sendClaim WILL refuse regardless of what the human decides here (see
 * ClaimSubmissionNotAutomatedError). Rather than transition to "sent" anyway and
 * let that refusal happen downstream — which used to leave the checkpoint
 * claiming "sent" forever even though nothing was ever dispatched, a real
 * correctness bug — this node picks the honest transition itself:
 * "needs_manual_submission" instead of "sent", and the graph never even attempts
 * sendClaim (see routeAfterApproval, which routes anything other than "sent" away
 * from it). The human's decision (approved/edited) is still recorded accurately;
 * only the DISPATCH outcome differs.
 *
 * NOTE ON POLARITY: this used to test `state.submissionWarning` — truthy meaning
 * "cannot send". It now tests `state.submission?.autoSendChannel` — truthy
 * meaning "CAN send". The sense is inverted, so a missing/blank value must fall
 * on the CANNOT side: a claim checkpointed before this change hydrates
 * `submission` as null/undefined and correctly ends at needs_manual_submission
 * rather than falsely reporting a send. Written with `?.` and a truthiness test
 * precisely so null, undefined and a plan without a channel all fail safe.
 */
export function createHumanApprovalNode(deps: HumanApprovalNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    const pendingStatus = applyTransition(state.claimStatus, "SUBMIT_FOR_APPROVAL");

    const decision = interrupt<HumanApprovalPayload, HumanApprovalDecision>({
      claimId: state.claimId,
      draftText: state.draftText,
    });

    await deps.auditLog.record({
      claimId: state.claimId,
      entryType: "human_decision",
      payload: { ...decision },
    });

    if (decision.action === "decline") {
      return {
        claimStatus: applyTransition(pendingStatus, "DECLINE"),
        approvalDecision: "declined",
      };
    }

    const dispatchEvent = state.submission?.autoSendChannel ? "SEND" : "CANNOT_AUTO_SEND";

    if (decision.action === "edit") {
      if (!decision.editedText) {
        throw new Error("humanApproval: action 'edit' requires editedText");
      }
      return {
        claimStatus: applyTransition(pendingStatus, dispatchEvent),
        approvalDecision: "edited",
        approvedText: decision.editedText,
      };
    }

    return {
      claimStatus: applyTransition(pendingStatus, dispatchEvent),
      approvalDecision: "approved",
      approvedText: state.draftText,
    };
  };
}

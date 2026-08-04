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
 * the original draft — approve and edit both reach "sent"; decline is terminal.
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

    if (decision.action === "edit") {
      if (!decision.editedText) {
        throw new Error("humanApproval: action 'edit' requires editedText");
      }
      return {
        claimStatus: applyTransition(pendingStatus, "SEND"),
        approvalDecision: "edited",
        approvedText: decision.editedText,
      };
    }

    return {
      claimStatus: applyTransition(pendingStatus, "SEND"),
      approvalDecision: "approved",
      approvedText: state.draftText,
    };
  };
}

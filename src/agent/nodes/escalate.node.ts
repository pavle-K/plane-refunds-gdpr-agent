import type { GraphStateType } from "../state.js";
import type { AuditLog } from "../../compliance/audit-log.js";
import { applyTransition } from "../../domain/claim/state-machine.js";

export interface EscalateNodeDeps {
  auditLog: AuditLog;
}

/** Flags for manual/legal escalation — reachable from "awaiting_response" (timeout) or "rejected" (rebuttal exhausted/not warranted). */
export function createEscalateNode(deps: EscalateNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    const reason = !state.airlineReplyText
      ? "Airline did not respond within the timeout window."
      : state.rebuttalCount > 0
        ? "Rebuttal limit reached without resolution."
        : "Rejected with insufficient evidence to support a rebuttal.";

    const event = state.claimStatus === "awaiting_response" ? "TIMEOUT" : "ESCALATE";
    const nextStatus = applyTransition(state.claimStatus, event);

    await deps.auditLog.record({
      claimId: state.claimId,
      entryType: "system_action",
      payload: { node: "escalate", reason },
    });

    return { claimStatus: nextStatus, escalationReason: reason };
  };
}

import { interrupt } from "@langchain/langgraph";
import type { GraphStateType } from "../state.js";
import { applyTransition } from "../../domain/claim/state-machine.js";

export type AwaitResponseEvent =
  | { type: "reply"; airlineReplyText: string }
  | { type: "timeout" };

export interface AwaitResponsePayload {
  claimId: string;
  awaiting: "airline_response";
}

/**
 * Long-running wait state — may sit for days/weeks (CLAUDE.md §2.2). Uses the same
 * interrupt()/Command(resume) mechanism as human-approval, resumed either by an
 * inbound-email webhook (`{type: "reply", ...}`) or a timeout sweep job
 * (`{type: "timeout"}`). Durable across process restarts via the checkpointer.
 */
export function createAwaitResponseNode() {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    const nextStatus = applyTransition(state.claimStatus, "CONFIRM_DISPATCHED");

    const event = interrupt<AwaitResponsePayload, AwaitResponseEvent>({
      claimId: state.claimId,
      awaiting: "airline_response",
    });

    return {
      claimStatus: nextStatus,
      airlineReplyText: event.type === "reply" ? event.airlineReplyText : null,
    };
  };
}

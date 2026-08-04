import type { GraphStateType } from "../state.js";
import { applyTransition } from "../../domain/claim/state-machine.js";

/**
 * Bookkeeping only — the actual rebuttal drafting happens when the graph loops
 * back to draft-claim.node.ts (§2.2: "rebut — loop back to draftClaim"). The
 * decision of whether to rebut vs. escalate belongs to edges/routing.ts, not here.
 */
export function createRebutNode() {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    return {
      claimStatus: applyTransition(state.claimStatus, "REBUT"),
      rebuttalCount: state.rebuttalCount + 1,
    };
  };
}

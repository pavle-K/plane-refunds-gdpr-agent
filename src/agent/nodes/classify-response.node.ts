import { z } from "zod";
import type { GraphStateType } from "../state.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AuditLog } from "../../compliance/audit-log.js";
import { callStructured } from "../llm/structured.js";
import { prompts } from "../prompts/index.js";
import { applyTransition } from "../../domain/claim/state-machine.js";
import type { ClaimStatus } from "../../domain/claim/claim.types.js";

export interface ClassifyResponseNodeDeps {
  llm: BaseChatModel;
  auditLog: AuditLog;
}

const classificationSchema = z.object({
  category: z.enum(["accepted", "rejected", "needs_info", "ambiguous"]),
  reasoning: z.string(),
  requestedInfo: z.array(z.string()).nullable(),
});

export function createClassifyResponseNode(deps: ClassifyResponseNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (!state.airlineReplyText) {
      throw new Error("classifyResponse: airlineReplyText is required");
    }

    const classification = await callStructured(deps.llm, {
      system: prompts.classifyResponse,
      prompt: state.airlineReplyText,
      schema: classificationSchema,
    });

    await deps.auditLog.record({
      claimId: state.claimId,
      entryType: "llm_output",
      payload: { node: "classifyResponse", classification },
    });

    // needs_info/ambiguous don't change claimStatus — still awaiting_response.
    let claimStatus: ClaimStatus = state.claimStatus;
    if (classification.category === "accepted") {
      claimStatus = applyTransition(state.claimStatus, "RECEIVE_ACCEPTANCE");
    } else if (classification.category === "rejected") {
      claimStatus = applyTransition(state.claimStatus, "RECEIVE_REJECTION");
    }

    return { responseClassification: classification, claimStatus };
  };
}

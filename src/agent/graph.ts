import { StateGraph, START, END } from "@langchain/langgraph";
import { GraphState } from "./state.js";
import { getCheckpointer } from "./checkpointer.js";
import {
  routeAfterEligibility,
  routeAfterApproval,
  routeAfterAwaitResponse,
  routeAfterClassification,
} from "./edges/routing.js";

import { createIngestNode, type IngestNodeDeps } from "./nodes/ingest.node.js";
import { createCheckEligibilityNode, type CheckEligibilityNodeDeps } from "./nodes/check-eligibility.node.js";
import { createScoreClaimNode, type ScoreClaimNodeDeps } from "./nodes/score-claim.node.js";
import { createDraftClaimNode, type DraftClaimNodeDeps } from "./nodes/draft-claim.node.js";
import { createHumanApprovalNode, type HumanApprovalNodeDeps } from "./nodes/human-approval.node.js";
import { createSendClaimNode, type SendClaimNodeDeps } from "./nodes/send-claim.node.js";
import { createAwaitResponseNode } from "./nodes/await-response.node.js";
import { createClassifyResponseNode, type ClassifyResponseNodeDeps } from "./nodes/classify-response.node.js";
import { createRebutNode } from "./nodes/rebut.node.js";
import { createEscalateNode, type EscalateNodeDeps } from "./nodes/escalate.node.js";
import { createProcessPayoutNode, type ProcessPayoutNodeDeps } from "./nodes/process-payout.node.js";

export type GraphDeps = IngestNodeDeps &
  CheckEligibilityNodeDeps &
  ScoreClaimNodeDeps &
  DraftClaimNodeDeps &
  HumanApprovalNodeDeps &
  SendClaimNodeDeps &
  ClassifyResponseNodeDeps &
  EscalateNodeDeps &
  ProcessPayoutNodeDeps;

/**
 * Node/edge wiring ONLY — no business logic (CLAUDE.md §3.3). Every node is thin;
 * all deps are injected so the whole graph can be built against fakes in tests
 * without touching a real provider, LLM, or database.
 */
export function buildGraph(deps: GraphDeps) {
  const builder = new StateGraph(GraphState)
    .addNode("ingest", createIngestNode(deps))
    .addNode("checkEligibility", createCheckEligibilityNode(deps))
    .addNode("scoreClaim", createScoreClaimNode(deps))
    .addNode("draftClaim", createDraftClaimNode(deps))
    .addNode("humanApproval", createHumanApprovalNode(deps))
    .addNode("sendClaim", createSendClaimNode(deps))
    .addNode("awaitResponse", createAwaitResponseNode())
    .addNode("classifyResponse", createClassifyResponseNode(deps))
    .addNode("rebut", createRebutNode())
    .addNode("escalate", createEscalateNode(deps))
    .addNode("processPayout", createProcessPayoutNode(deps))

    .addEdge(START, "ingest")
    .addEdge("ingest", "checkEligibility")
    .addConditionalEdges("checkEligibility", routeAfterEligibility, {
      scoreClaim: "scoreClaim",
      ineligible: END,
    })
    .addEdge("scoreClaim", "draftClaim")
    .addEdge("draftClaim", "humanApproval")
    .addConditionalEdges("humanApproval", routeAfterApproval, {
      sendClaim: "sendClaim",
      declined: END,
    })
    .addEdge("sendClaim", "awaitResponse")
    .addConditionalEdges("awaitResponse", routeAfterAwaitResponse, {
      classifyResponse: "classifyResponse",
      escalate: "escalate",
    })
    .addConditionalEdges("classifyResponse", routeAfterClassification, {
      processPayout: "processPayout",
      awaitResponse: "awaitResponse",
      rebut: "rebut",
      escalate: "escalate",
    })
    .addEdge("rebut", "draftClaim")
    .addEdge("escalate", END)
    .addEdge("processPayout", END);

  return builder.compile({ checkpointer: getCheckpointer() });
}

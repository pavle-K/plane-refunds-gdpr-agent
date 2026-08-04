import { StateGraph, START, END } from "@langchain/langgraph";
import { GraphState, type GraphStateType } from "./state.js";
import { getCheckpointer } from "./checkpointer.js";

// No-op stub nodes — Stage 0 only proves the graph wires up and checkpoints correctly.
// Real nodes (ingest, checkEligibility, draftClaim, ...) land in Stage 2, per CLAUDE.md §2.2,
// one file per node under src/agent/nodes/.
function stepOne(_state: GraphStateType) {
  return { stepsCompleted: ["stepOne"] };
}

function stepTwo(_state: GraphStateType) {
  return { stepsCompleted: ["stepTwo"] };
}

const builder = new StateGraph(GraphState)
  .addNode("stepOne", stepOne)
  .addNode("stepTwo", stepTwo)
  .addEdge(START, "stepOne")
  .addEdge("stepOne", "stepTwo")
  .addEdge("stepTwo", END);

export function buildGraph() {
  return builder.compile({ checkpointer: getCheckpointer() });
}

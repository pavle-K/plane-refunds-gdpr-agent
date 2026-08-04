import { describe, it, expect } from "vitest";
import { StateGraph, START, END, MemorySaver, Command } from "@langchain/langgraph";
import { GraphState } from "../../../../src/agent/state.js";
import { createAwaitResponseNode } from "../../../../src/agent/nodes/await-response.node.js";

function buildMiniGraph() {
  const builder = new StateGraph(GraphState)
    .addNode("awaitResponse", createAwaitResponseNode())
    .addEdge(START, "awaitResponse")
    .addEdge("awaitResponse", END);
  return builder.compile({ checkpointer: new MemorySaver() });
}

function threadConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

describe("await-response node", () => {
  it("interrupts and transitions claimStatus to awaiting_response", async () => {
    const graph = buildMiniGraph();
    const config = threadConfig("t1");

    const result = (await graph.invoke(
      { claimId: "c1", claimStatus: "sent" },
      config,
    )) as Record<string, unknown>;

    expect(result["__interrupt__"]).toBeDefined();
    const state = await graph.getState(config);
    expect(state.next).toEqual(["awaitResponse"]);
  });

  it("resumes with a reply and stores the reply text", async () => {
    const graph = buildMiniGraph();
    const config = threadConfig("t2");

    await graph.invoke({ claimId: "c1", claimStatus: "sent" }, config);
    const result = await graph.invoke(
      new Command({ resume: { type: "reply", airlineReplyText: "We reject this claim." } }),
      config,
    );

    expect(result.claimStatus).toBe("awaiting_response");
    expect(result.airlineReplyText).toBe("We reject this claim.");
  });

  it("resumes with a timeout and leaves airlineReplyText null", async () => {
    const graph = buildMiniGraph();
    const config = threadConfig("t3");

    await graph.invoke({ claimId: "c1", claimStatus: "sent" }, config);
    const result = await graph.invoke(new Command({ resume: { type: "timeout" } }), config);

    expect(result.claimStatus).toBe("awaiting_response");
    expect(result.airlineReplyText).toBeNull();
  });
});

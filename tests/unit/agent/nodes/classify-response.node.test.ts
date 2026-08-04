import { describe, it, expect } from "vitest";
import { createClassifyResponseNode } from "../../../../src/agent/nodes/classify-response.node.js";
import { FakeLlmClient } from "../../../../src/agent/llm/fake.js";
import { FakeAuditLog } from "../../../../src/compliance/audit-log.fake.js";
import { IllegalTransitionError } from "../../../../src/domain/claim/state-machine.js";
import { buildState } from "../../../helpers/build-state.js";

function buildDeps() {
  return { llm: new FakeLlmClient(), auditLog: new FakeAuditLog() };
}

describe("classify-response node", () => {
  it("classifies a rejection and transitions claimStatus to rejected", async () => {
    const deps = buildDeps();
    deps.llm.enqueueJson({ category: "rejected", reasoning: "cites technical fault", requestedInfo: null });
    const node = createClassifyResponseNode(deps);

    const result = await node(
      buildState({ claimStatus: "awaiting_response", airlineReplyText: "We reject this claim." }),
    );

    expect(result.responseClassification?.category).toBe("rejected");
    expect(result.claimStatus).toBe("rejected");
    expect(deps.llm.calls[0]?.prompt).toBe("We reject this claim.");
    expect(deps.auditLog.entries[0]?.entryType).toBe("llm_output");
  });

  it("classifies an acceptance and transitions claimStatus to accepted", async () => {
    const deps = buildDeps();
    deps.llm.enqueueJson({ category: "accepted", reasoning: "airline agreed", requestedInfo: null });
    const node = createClassifyResponseNode(deps);

    const result = await node(
      buildState({ claimStatus: "awaiting_response", airlineReplyText: "We accept this claim." }),
    );

    expect(result.claimStatus).toBe("accepted");
  });

  it("leaves claimStatus unchanged for needs_info/ambiguous", async () => {
    const deps = buildDeps();
    deps.llm.enqueueJson({ category: "needs_info", reasoning: "wants docs", requestedInfo: ["boarding pass"] });
    const node = createClassifyResponseNode(deps);

    const result = await node(
      buildState({ claimStatus: "awaiting_response", airlineReplyText: "Please send your boarding pass." }),
    );

    expect(result.claimStatus).toBe("awaiting_response");
  });

  it("throws if airlineReplyText is missing", async () => {
    const deps = buildDeps();
    const node = createClassifyResponseNode(deps);
    await expect(node(buildState())).rejects.toThrow();
  });

  it("refuses an illegal transition (e.g. classifying from a status that can't receive a response)", async () => {
    const deps = buildDeps();
    deps.llm.enqueueJson({ category: "rejected", reasoning: "r", requestedInfo: null });
    const node = createClassifyResponseNode(deps);

    await expect(
      node(buildState({ claimStatus: "draft", airlineReplyText: "irrelevant" })),
    ).rejects.toThrow(IllegalTransitionError);
  });
});

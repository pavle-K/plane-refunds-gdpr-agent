import { describe, it, expect } from "vitest";
import { StateGraph, START, END, MemorySaver, Command } from "@langchain/langgraph";
import { GraphState } from "../../../../src/agent/state.js";
import { createProcessPayoutNode } from "../../../../src/agent/nodes/process-payout.node.js";
import { FakePaymentsAdapter } from "../../../../src/providers/payments/fake.adapter.js";
import { FakeAuditLog } from "../../../../src/compliance/audit-log.fake.js";
import { buildState } from "../../../helpers/build-state.js";

function buildDeps() {
  return { payments: new FakePaymentsAdapter(), auditLog: new FakeAuditLog() };
}

describe("process-payout node — payment already confirmed", () => {
  it("splits the received amount and transfers the payout portion", async () => {
    const deps = buildDeps();
    const node = createProcessPayoutNode(deps);

    const result = await node(
      buildState({ claimStatus: "accepted", receivedAmountCents: 60000, connectedAccountId: "acct_1" }),
    );

    expect(result.claimStatus).toBe("paid");
    expect(result.payout?.commissionCents).toBe(15000);
    expect(result.payout?.payoutCents).toBe(45000);
    expect(deps.payments.transfers).toHaveLength(1);
    expect(deps.payments.transfers[0]?.payoutCents).toBe(45000);
  });

  it("audit-logs the payout", async () => {
    const deps = buildDeps();
    const node = createProcessPayoutNode(deps);

    await node(buildState({ claimStatus: "accepted", receivedAmountCents: 60000, connectedAccountId: "acct_1" }));

    expect(deps.auditLog.entries[0]?.entryType).toBe("system_action");
  });

  it("refuses an illegal transition (e.g. not yet accepted)", async () => {
    const deps = buildDeps();
    const node = createProcessPayoutNode(deps);
    await expect(
      node(buildState({ claimStatus: "sent", receivedAmountCents: 60000, connectedAccountId: "acct_1" })),
    ).rejects.toThrow();
  });
});

/**
 * "Trigger the split once the airline pays" — when payment hasn't been confirmed
 * yet, this node interrupts and waits, same mechanism as human-approval and
 * await-response. Needs a real mini-graph, same reason as those two.
 */
describe("process-payout node — waiting for payment confirmation", () => {
  function buildMiniGraph() {
    const deps = buildDeps();
    const builder = new StateGraph(GraphState)
      .addNode("processPayout", createProcessPayoutNode(deps))
      .addEdge(START, "processPayout")
      .addEdge("processPayout", END);
    return { graph: builder.compile({ checkpointer: new MemorySaver() }), deps };
  }

  function threadConfig(threadId: string) {
    return { configurable: { thread_id: threadId } };
  }

  it("interrupts when receivedAmountCents/connectedAccountId aren't known yet", async () => {
    const { graph, deps } = buildMiniGraph();
    const config = threadConfig("payout-interrupt-1");

    const result = (await graph.invoke(
      { claimId: "c1", claimStatus: "accepted" },
      config,
    )) as Record<string, unknown>;

    expect(result["__interrupt__"]).toBeDefined();
    expect(deps.payments.transfers).toHaveLength(0);
  });

  it("resumes with a payment-confirmation event and completes the payout", async () => {
    const { graph, deps } = buildMiniGraph();
    const config = threadConfig("payout-resume-1");

    await graph.invoke({ claimId: "c1", claimStatus: "accepted" }, config);
    const result = await graph.invoke(
      new Command({ resume: { receivedAmountCents: 60000, connectedAccountId: "acct_1" } }),
      config,
    );

    expect(result.claimStatus).toBe("paid");
    expect(result.payout?.payoutCents).toBe(45000);
    expect(deps.payments.transfers).toHaveLength(1);
  });
});

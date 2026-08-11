import { describe, it, expect } from "vitest";
import { StateGraph, START, END, MemorySaver, Command } from "@langchain/langgraph";
import { GraphState } from "../../../../src/agent/state.js";
import { createHumanApprovalNode } from "../../../../src/agent/nodes/human-approval.node.js";
import { createSendClaimNode } from "../../../../src/agent/nodes/send-claim.node.js";
import { FakeAuditLog } from "../../../../src/compliance/audit-log.fake.js";
import { FakeEmailSendAdapter } from "../../../../src/providers/email-send/fake.adapter.js";
import { buildAnyCodeEmailAirlineDirectory } from "../../../../src/providers/airline-directory/fake.adapter.js";
import type { Booking } from "../../../../src/domain/claim/claim.types.js";

/**
 * This can't be a bare function-call unit test: interrupt() requires real graph
 * execution context (it throws "called outside the context of a graph"
 * otherwise). So this builds the smallest real graph that exercises the
 * approval gate, using LangGraph's in-memory checkpointer (no DB needed) — see
 * CLAUDE.md §5.3: "the most important node test in the project."
 */
function buildMiniGraph() {
  const auditLog = new FakeAuditLog();
  const emailSend = new FakeEmailSendAdapter();
  const airlineDirectory = buildAnyCodeEmailAirlineDirectory();

  const builder = new StateGraph(GraphState)
    .addNode("humanApproval", createHumanApprovalNode({ auditLog }))
    .addNode("sendClaim", createSendClaimNode({ emailSend, airlineDirectory, auditLog }))
    .addEdge(START, "humanApproval")
    .addConditionalEdges(
      "humanApproval",
      (state) => (state.claimStatus === "sent" ? "sendClaim" : "declined"),
      { sendClaim: "sendClaim", declined: END },
    )
    .addEdge("sendClaim", END);

  const graph = builder.compile({ checkpointer: new MemorySaver() });
  return { graph, auditLog, emailSend };
}

const BOOKING: Booking = {
  bookingReference: "ABC123",
  passengers: [{ id: "p1", fullName: "Jane Doe", email: "jane@example.com" }],
  segments: [
    {
      flightNumber: "LH456",
      operatingCarrierCode: "LH",
      scheduledDepartureUtc: "2024-06-15T09:00:00.000Z",
      scheduledArrivalUtc: "2024-06-15T18:00:00.000Z",
    },
  ],
};

function threadConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

describe("human-approval node — the mandatory pause before any outbound send", () => {
  it("interrupts the graph and sends NOTHING before resume", async () => {
    const { graph, emailSend } = buildMiniGraph();
    const config = threadConfig("interrupt-1");

    const result = (await graph.invoke(
      { claimId: "c1", claimStatus: "draft", booking: BOOKING, draftText: "Dear airline..." },
      config,
    )) as Record<string, unknown>;

    expect(result["__interrupt__"]).toBeDefined();
    expect(emailSend.sentEmails).toHaveLength(0);

    const state = await graph.getState(config);
    expect(state.next).toEqual(["humanApproval"]);
  });

  it("approve → proceeds to send with the original draft text", async () => {
    const { graph, emailSend } = buildMiniGraph();
    const config = threadConfig("approve-1");

    await graph.invoke(
      { claimId: "c1", claimStatus: "draft", booking: BOOKING, draftText: "Dear airline..." },
      config,
    );
    const result = await graph.invoke(new Command({ resume: { action: "approve" } }), config);

    expect(result.claimStatus).toBe("sent");
    expect(result.approvalDecision).toBe("approved");
    expect(emailSend.sentEmails).toHaveLength(1);
    expect(emailSend.sentEmails[0]?.textBody).toBe("Dear airline...");
  });

  it("edit → proceeds with the EDITED text, not the original draft", async () => {
    const { graph, emailSend } = buildMiniGraph();
    const config = threadConfig("edit-1");

    await graph.invoke(
      { claimId: "c1", claimStatus: "draft", booking: BOOKING, draftText: "original draft" },
      config,
    );
    const result = await graph.invoke(
      new Command({ resume: { action: "edit", editedText: "human-edited text" } }),
      config,
    );

    expect(result.claimStatus).toBe("sent");
    expect(result.approvalDecision).toBe("edited");
    expect(emailSend.sentEmails).toHaveLength(1);
    expect(emailSend.sentEmails[0]?.textBody).toBe("human-edited text");
  });

  it("decline → terminates, never sending", async () => {
    const { graph, emailSend } = buildMiniGraph();
    const config = threadConfig("decline-1");

    await graph.invoke(
      { claimId: "c1", claimStatus: "draft", booking: BOOKING, draftText: "Dear airline..." },
      config,
    );
    const result = await graph.invoke(new Command({ resume: { action: "decline" } }), config);

    expect(result.claimStatus).toBe("declined");
    expect(emailSend.sentEmails).toHaveLength(0);
  });

  it("approve on a carrier with no automated send path → needs_manual_submission, sendClaim never runs", async () => {
    const { graph, emailSend } = buildMiniGraph();
    const config = threadConfig("no-auto-send-1");

    await graph.invoke(
      {
        claimId: "c1",
        claimStatus: "draft",
        booking: BOOKING,
        draftText: "Submit it here: https://example-airline.test/claims",
        submissionWarning: "This airline requires claims to be submitted through their own web form.",
      },
      config,
    );
    const result = await graph.invoke(new Command({ resume: { action: "approve" } }), config);

    expect(result.claimStatus).toBe("needs_manual_submission");
    expect(result.approvalDecision).toBe("approved");
    expect(result.approvedText).toBe("Submit it here: https://example-airline.test/claims");
    expect(emailSend.sentEmails).toHaveLength(0); // sendClaim was never reached, not just refused
  });

  it("edit on a carrier with no automated send path also lands on needs_manual_submission", async () => {
    const { graph, emailSend } = buildMiniGraph();
    const config = threadConfig("no-auto-send-2");

    await graph.invoke(
      {
        claimId: "c1",
        claimStatus: "draft",
        booking: BOOKING,
        draftText: "original packet",
        submissionWarning: "no automated channel",
      },
      config,
    );
    const result = await graph.invoke(
      new Command({ resume: { action: "edit", editedText: "human-edited packet" } }),
      config,
    );

    expect(result.claimStatus).toBe("needs_manual_submission");
    expect(result.approvedText).toBe("human-edited packet");
    expect(emailSend.sentEmails).toHaveLength(0);
  });

  it("records every human decision in the audit log", async () => {
    const { graph, auditLog } = buildMiniGraph();
    const config = threadConfig("audit-1");

    await graph.invoke(
      { claimId: "c1", claimStatus: "draft", booking: BOOKING, draftText: "Dear airline..." },
      config,
    );
    await graph.invoke(new Command({ resume: { action: "approve" } }), config);

    // Also expect a "system_action" entry from sendClaim continuing after approval —
    // the human decision itself must be the first entry recorded.
    const humanDecisionEntries = auditLog.entries.filter((e) => e.entryType === "human_decision");
    expect(humanDecisionEntries).toHaveLength(1);
    expect(auditLog.entries[0]?.entryType).toBe("human_decision");
  });
});

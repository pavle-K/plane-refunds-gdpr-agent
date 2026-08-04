import { describe, it, expect } from "vitest";
import { createEscalateNode } from "../../../../src/agent/nodes/escalate.node.js";
import { FakeAuditLog } from "../../../../src/compliance/audit-log.fake.js";
import { buildState } from "../../../helpers/build-state.js";

function buildDeps() {
  return { auditLog: new FakeAuditLog() };
}

describe("escalate node", () => {
  it("escalates a timed-out wait (no reply text) with a timeout reason", async () => {
    const deps = buildDeps();
    const node = createEscalateNode(deps);

    const result = await node(buildState({ claimStatus: "awaiting_response", airlineReplyText: null }));

    expect(result.claimStatus).toBe("escalated");
    expect(result.escalationReason).toContain("did not respond");
  });

  it("escalates a rejected claim at the rebuttal limit with a limit-reached reason", async () => {
    const deps = buildDeps();
    const node = createEscalateNode(deps);

    const result = await node(
      buildState({ claimStatus: "rejected", airlineReplyText: "no", rebuttalCount: 2 }),
    );

    expect(result.claimStatus).toBe("escalated");
    expect(result.escalationReason).toContain("Rebuttal limit");
  });

  it("escalates a rejected claim with weak evidence and no rebuttal attempts", async () => {
    const deps = buildDeps();
    const node = createEscalateNode(deps);

    const result = await node(
      buildState({ claimStatus: "rejected", airlineReplyText: "no", rebuttalCount: 0 }),
    );

    expect(result.escalationReason).toContain("insufficient evidence");
  });

  it("audit-logs the escalation", async () => {
    const deps = buildDeps();
    const node = createEscalateNode(deps);
    await node(buildState({ claimStatus: "awaiting_response", airlineReplyText: null }));

    expect(deps.auditLog.entries).toHaveLength(1);
    expect(deps.auditLog.entries[0]?.entryType).toBe("system_action");
  });
});

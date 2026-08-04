import { describe, it, expect } from "vitest";
import { FakeAuditLog } from "../../../src/compliance/audit-log.fake.js";

describe("FakeAuditLog", () => {
  it("records entries in order without touching the database", async () => {
    const log = new FakeAuditLog();
    await log.record({ claimId: "c1", entryType: "llm_output", payload: { a: 1 } });
    await log.record({ claimId: "c1", entryType: "human_decision", payload: { decision: "approve" } });

    expect(log.entries).toEqual([
      { claimId: "c1", entryType: "llm_output", payload: { a: 1 } },
      { claimId: "c1", entryType: "human_decision", payload: { decision: "approve" } },
    ]);
  });
});

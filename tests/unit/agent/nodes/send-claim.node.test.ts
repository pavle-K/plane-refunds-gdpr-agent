import { describe, it, expect } from "vitest";
import { createSendClaimNode, ClaimNotApprovedError } from "../../../../src/agent/nodes/send-claim.node.js";
import { FakeEmailSendAdapter } from "../../../../src/providers/email-send/fake.adapter.js";
import { StaticAirlineDirectoryAdapter } from "../../../../src/providers/airline-directory/static.adapter.js";
import { FakeAuditLog } from "../../../../src/compliance/audit-log.fake.js";
import { buildState } from "../../../helpers/build-state.js";
import type { Booking } from "../../../../src/domain/claim/claim.types.js";

const BOOKING: Booking = {
  bookingReference: "ABC123",
  passengers: [{ id: "p1", fullName: "Jane Doe", email: "jane@example.com" }],
  flightNumber: "LH456",
  operatingCarrierCode: "LH",
  scheduledDepartureUtc: "2024-06-15T09:00:00.000Z",
  scheduledArrivalUtc: "2024-06-15T18:00:00.000Z",
};

function buildDeps() {
  const emailSend = new FakeEmailSendAdapter();
  const airlineDirectory = new StaticAirlineDirectoryAdapter();
  const auditLog = new FakeAuditLog();
  return { emailSend, airlineDirectory, auditLog };
}

describe("send-claim node — defense in depth", () => {
  it.each(["draft", "pending_approval", "declined", "awaiting_response", "rejected"] as const)(
    "refuses to send when claimStatus is '%s' (approval gate not passed)",
    async (claimStatus) => {
      const deps = buildDeps();
      const node = createSendClaimNode(deps);
      const state = buildState({ claimStatus, booking: BOOKING, approvedText: "text" });

      await expect(node(state)).rejects.toThrow(ClaimNotApprovedError);
      expect(deps.emailSend.sentEmails).toHaveLength(0);
    },
  );

  it("sends when claimStatus is 'sent' and records the outcome", async () => {
    const deps = buildDeps();
    const node = createSendClaimNode(deps);
    const state = buildState({ claimStatus: "sent", booking: BOOKING, approvedText: "Dear Lufthansa..." });

    const result = await node(state);

    expect(deps.emailSend.sentEmails).toHaveLength(1);
    expect(deps.emailSend.sentEmails[0]?.textBody).toBe("Dear Lufthansa...");
    expect(result.sendReceipt).toBeDefined();
    expect(deps.auditLog.entries).toHaveLength(1);
    expect(deps.auditLog.entries[0]?.entryType).toBe("system_action");
  });

  it("throws if approvedText is missing even when claimStatus is 'sent'", async () => {
    const deps = buildDeps();
    const node = createSendClaimNode(deps);
    const state = buildState({ claimStatus: "sent", booking: BOOKING, approvedText: null });

    await expect(node(state)).rejects.toThrow();
    expect(deps.emailSend.sentEmails).toHaveLength(0);
  });
});

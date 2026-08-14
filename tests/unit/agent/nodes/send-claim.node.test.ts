import { describe, it, expect } from "vitest";
import {
  createSendClaimNode,
  ClaimNotApprovedError,
  ClaimSubmissionNotAutomatedError,
  MissingSenderAddressError,
} from "../../../../src/agent/nodes/send-claim.node.js";
import { FakeEmailSendAdapter } from "../../../../src/providers/email-send/fake.adapter.js";
import { StaticAirlineDirectoryAdapter } from "../../../../src/providers/airline-directory/static.adapter.js";
import { buildAnyCodeEmailAirlineDirectory } from "../../../../src/providers/airline-directory/fake.adapter.js";
import { FakeAuditLog } from "../../../../src/compliance/audit-log.fake.js";
import { buildState } from "../../../helpers/build-state.js";
import { buildOnTimeResult } from "../../../../src/providers/flight-status/fake.adapter.js";
import type { Booking } from "../../../../src/domain/claim/claim.types.js";

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

const SENDER = "claims@refunds.test";

function buildDeps() {
  const emailSend = new FakeEmailSendAdapter();
  const airlineDirectory = new StaticAirlineDirectoryAdapter();
  const auditLog = new FakeAuditLog();
  return { emailSend, airlineDirectory, auditLog, fromAddress: SENDER };
}

describe("send-claim node — defense in depth", () => {
  it.each(["draft", "pending_approval", "declined", "needs_manual_submission", "awaiting_response", "rejected"] as const)(
    "refuses to send when claimStatus is '%s' (approval gate not passed)",
    async (claimStatus) => {
      const deps = buildDeps();
      const node = createSendClaimNode(deps);
      const state = buildState({ claimStatus, booking: BOOKING, approvedText: "text" });

      await expect(node(state)).rejects.toThrow(ClaimNotApprovedError);
      expect(deps.emailSend.sentEmails).toHaveLength(0);
    },
  );

  it("sends when claimStatus is 'sent', the carrier's submission method is email, and records the outcome", async () => {
    const deps = {
      emailSend: new FakeEmailSendAdapter(),
      airlineDirectory: buildAnyCodeEmailAirlineDirectory(),
      auditLog: new FakeAuditLog(),
      fromAddress: SENDER,
    };
    const node = createSendClaimNode(deps);
    const state = buildState({ claimStatus: "sent", booking: BOOKING, approvedText: "Dear Lufthansa..." });

    const result = await node(state);

    expect(deps.emailSend.sentEmails).toHaveLength(1);
    expect(deps.emailSend.sentEmails[0]?.from).toBe(SENDER);
    expect(deps.emailSend.sentEmails[0]?.textBody).toBe("Dear Lufthansa...");
    expect(deps.emailSend.sentEmails[0]?.to).toBe("claims@lufthansa.example.test");
    expect(result.sendReceipt).toBeDefined();
    expect(deps.auditLog.entries).toHaveLength(1);
    expect(deps.auditLog.entries[0]?.entryType).toBe("system_action");
  });

  it("throws if approvedText is missing even when claimStatus is 'sent'", async () => {
    const deps = {
      emailSend: new FakeEmailSendAdapter(),
      airlineDirectory: buildAnyCodeEmailAirlineDirectory(),
      auditLog: new FakeAuditLog(),
      fromAddress: SENDER,
    };
    const node = createSendClaimNode(deps);
    const state = buildState({ claimStatus: "sent", booking: BOOKING, approvedText: null });

    await expect(node(state)).rejects.toThrow();
    expect(deps.emailSend.sentEmails).toHaveLength(0);
  });

  it("refuses to send when the carrier's submission method isn't email, even when approved — real directory data", async () => {
    const deps = buildDeps(); // StaticAirlineDirectoryAdapter — LH is "unsupported" in the real data
    const node = createSendClaimNode(deps);
    const state = buildState({ claimStatus: "sent", booking: BOOKING, approvedText: "Dear Lufthansa..." });

    await expect(node(state)).rejects.toThrow(ClaimSubmissionNotAutomatedError);
    expect(deps.emailSend.sentEmails).toHaveLength(0);
    expect(deps.auditLog.entries).toHaveLength(0);
  });

  it("refuses to send when no sender address is configured, rather than using a placeholder", async () => {
    const deps = {
      emailSend: new FakeEmailSendAdapter(),
      airlineDirectory: buildAnyCodeEmailAirlineDirectory(),
      auditLog: new FakeAuditLog(),
    };
    const node = createSendClaimNode(deps);
    const state = buildState({ claimStatus: "sent", booking: BOOKING, approvedText: "Dear Lufthansa..." });

    await expect(node(state)).rejects.toThrow(MissingSenderAddressError);
    expect(deps.emailSend.sentEmails).toHaveLength(0);
    expect(deps.auditLog.entries).toHaveLength(0);
  });

  it("resolves the carrier from flightStatuses, not the booking's flight-number prefix (codeshare)", async () => {
    const seen: string[] = [];
    const deps = {
      emailSend: new FakeEmailSendAdapter(),
      airlineDirectory: {
        async getAirline(carrierIataCode: string) {
          seen.push(carrierIataCode);
          return buildAnyCodeEmailAirlineDirectory().getAirline(carrierIataCode);
        },
        listAirlines: () => buildAnyCodeEmailAirlineDirectory().listAirlines(),
      },
      auditLog: new FakeAuditLog(),
      fromAddress: SENDER,
    };
    const node = createSendClaimNode(deps);
    // Booking says "LH" (the flight-number prefix); the flight-status lookup
    // reports the real operating carrier as "IB". draft-claim/check-eligibility
    // both use the latter, so this node must too.
    const state = buildState({
      claimStatus: "sent",
      booking: BOOKING,
      approvedText: "Dear Iberia...",
      flightStatuses: [buildOnTimeResult({ flightNumber: "LH456", operatingCarrierIataCode: "IB" })],
    });

    await node(state);

    expect(seen).toEqual(["IB"]);
  });
});

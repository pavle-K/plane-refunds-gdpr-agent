import { describe, it, expect } from "vitest";
import { createDraftClaimNode } from "../../../../src/agent/nodes/draft-claim.node.js";
import { FakeLlmClient } from "../../../../src/agent/llm/fake.js";
import { FakeAuditLog } from "../../../../src/compliance/audit-log.fake.js";
import { buildState } from "../../../helpers/build-state.js";
import type { Booking } from "../../../../src/domain/claim/claim.types.js";
import type { FlightStatusResult } from "../../../../src/providers/flight-status/flight-status.port.js";

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

const FLIGHT_STATUS: FlightStatusResult = {
  flightNumber: "LH456",
  operatingCarrierIataCode: "LH",
  departureAirportIata: "FRA",
  arrivalAirportIata: "SIN",
  scheduledDepartureUtc: "2024-06-15T09:00:00.000Z",
  actualDepartureUtc: null,
  scheduledArrivalUtc: "2024-06-15T18:00:00.000Z",
  actualArrivalUtc: null,
  status: "delayed",
  delayMinutesAtArrival: 220,
  cancellationNoticeDays: null,
};

function buildDeps() {
  return { llm: new FakeLlmClient(), auditLog: new FakeAuditLog() };
}

describe("draft-claim node", () => {
  it("drafts using the original-claim prompt when there's no prior rejection", async () => {
    const deps = buildDeps();
    deps.llm.enqueueJson({ letterText: "Dear Lufthansa, ..." });
    const node = createDraftClaimNode(deps);

    const result = await node(
      buildState({ booking: BOOKING, flightStatuses: [FLIGHT_STATUS], compensationCents: 60000 }),
    );

    expect(result.draftText).toBe("Dear Lufthansa, ...");
    expect(deps.llm.calls[0]?.system).toContain("Draft Claim");
    expect(deps.auditLog.entries[0]?.payload["isRebuttal"]).toBe(false);
  });

  it("switches to the rebuttal prompt when the last response was rejected", async () => {
    const deps = buildDeps();
    deps.llm.enqueueJson({ letterText: "Dear Lufthansa, in response to your rejection..." });
    const node = createDraftClaimNode(deps);

    const state = buildState({
      booking: BOOKING,
      flightStatuses: [FLIGHT_STATUS],
      compensationCents: 60000,
      airlineReplyText: "We reject this claim due to a technical fault.",
      responseClassification: { category: "rejected", reasoning: "r", requestedInfo: null },
    });

    const result = await node(state);

    expect(result.draftText).toContain("rejection");
    expect(deps.llm.calls[0]?.system).toContain("Rebut");
    expect(deps.auditLog.entries[0]?.payload["isRebuttal"]).toBe(true);
  });

  it("throws if required facts are missing", async () => {
    const deps = buildDeps();
    const node = createDraftClaimNode(deps);
    await expect(node(buildState())).rejects.toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { createDraftClaimNode } from "../../../../src/agent/nodes/draft-claim.node.js";
import { FakeLlmClient } from "../../../../src/agent/llm/fake.adapter.js";
import { FakeAuditLog } from "../../../../src/compliance/audit-log.fake.js";
import { StaticAirlineDirectoryAdapter } from "../../../../src/providers/airline-directory/static.adapter.js";
import { buildAnyCodeEmailAirlineDirectory, buildAirlineClaimsContact } from "../../../../src/providers/airline-directory/fake.adapter.js";
import { buildState } from "../../../helpers/build-state.js";
import type { Booking } from "../../../../src/domain/claim/claim.types.js";
import type { FlightStatusResult } from "../../../../src/providers/flight-status/flight-status.port.js";
import type { AirlineDirectoryProvider } from "../../../../src/providers/airline-directory/airline-directory.port.js";
import { ok } from "../../../../src/lib/result.js";

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
  return { llm: new FakeLlmClient(), airlineDirectory: new StaticAirlineDirectoryAdapter(), auditLog: new FakeAuditLog() };
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

describe("draft-claim node — submissionWarning", () => {
  it("sets a warning when the carrier's submission channel is unsupported (real directory data)", async () => {
    const deps = buildDeps(); // StaticAirlineDirectoryAdapter — LH is "unsupported" in the real data
    deps.llm.enqueueJson({ letterText: "Dear Lufthansa, ..." });
    const node = createDraftClaimNode(deps);

    const result = await node(
      buildState({ booking: BOOKING, flightStatuses: [FLIGHT_STATUS], compensationCents: 60000 }),
    );

    expect(result.submissionWarning).toContain("Lufthansa");
  });

  it("sets no warning when the carrier's submission method is email", async () => {
    const deps = { llm: new FakeLlmClient(), airlineDirectory: buildAnyCodeEmailAirlineDirectory(), auditLog: new FakeAuditLog() };
    deps.llm.enqueueJson({ letterText: "Dear Lufthansa, ..." });
    const node = createDraftClaimNode(deps);

    const result = await node(
      buildState({ booking: BOOKING, flightStatuses: [FLIGHT_STATUS], compensationCents: 60000 }),
    );

    expect(result.submissionWarning).toBeNull();
  });

  it("sets a warning when the carrier has no directory entry at all", async () => {
    const deps = buildDeps();
    deps.llm.enqueueJson({ letterText: "Dear Unknown Airline, ..." });
    const node = createDraftClaimNode(deps);

    const unknownCarrierFlightStatus: FlightStatusResult = { ...FLIGHT_STATUS, operatingCarrierIataCode: "ZZ" };
    const result = await node(
      buildState({ booking: BOOKING, flightStatuses: [unknownCarrierFlightStatus], compensationCents: 60000 }),
    );

    expect(result.submissionWarning).toContain("don't have a directory entry");
  });
});

function buildWebFormAirlineDirectory(): AirlineDirectoryProvider {
  const contact = buildAirlineClaimsContact({
    carrierIataCode: "FR",
    carrierName: "Ryanair",
    submissionMethod: {
      type: "web_form",
      formUrl: "https://eu261claims.ryanair.com/",
      requiredFields: ["fullName", "iban"],
    },
  });
  return {
    async getAirline(carrierIataCode: string) {
      return ok({ ...contact, carrierIataCode });
    },
    async listAirlines() {
      return [contact];
    },
  };
}

describe("draft-claim node — web_form carriers get a submission packet, not a letter", () => {
  it("builds a deterministic packet with the link and claim facts, without calling the LLM", async () => {
    const deps = { llm: new FakeLlmClient(), airlineDirectory: buildWebFormAirlineDirectory(), auditLog: new FakeAuditLog() };
    const node = createDraftClaimNode(deps);

    const result = await node(
      buildState({ booking: BOOKING, flightStatuses: [FLIGHT_STATUS], compensationCents: 60000, eligibilityReason: "Arrival delay of 220 minute(s) meets the 180-minute threshold." }),
    );

    expect(deps.llm.calls).toHaveLength(0);
    expect(result.draftText).toContain("https://eu261claims.ryanair.com/");
    expect(result.draftText).toContain("ABC123"); // booking reference
    expect(result.draftText).toContain("Jane Doe");
    expect(result.draftText).toContain("LH456");
    expect(result.draftText).toContain("€600");
    expect(result.draftText).toContain("full name");
    expect(result.draftText).toContain("IBAN");
    expect(result.submissionWarning).toContain("Ryanair");
    expect(deps.auditLog.entries).toHaveLength(1);
    expect(deps.auditLog.entries[0]?.entryType).toBe("system_action");
  });

  it("still uses the LLM-drafted letter path for a rebuttal, even for a web_form carrier (unreachable today, but must fail safe)", async () => {
    const deps = { llm: new FakeLlmClient(), airlineDirectory: buildWebFormAirlineDirectory(), auditLog: new FakeAuditLog() };
    deps.llm.enqueueJson({ letterText: "Dear Ryanair, in response to your rejection..." });
    const node = createDraftClaimNode(deps);

    const state = buildState({
      booking: BOOKING,
      flightStatuses: [FLIGHT_STATUS],
      compensationCents: 60000,
      airlineReplyText: "We reject this claim.",
      responseClassification: { category: "rejected", reasoning: "r", requestedInfo: null },
    });

    const result = await node(state);

    expect(deps.llm.calls).toHaveLength(1);
    expect(result.draftText).toContain("rejection");
  });
});

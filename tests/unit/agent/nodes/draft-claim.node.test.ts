import { describe, it, expect } from "vitest";
import { createDraftClaimNode } from "../../../../src/agent/nodes/draft-claim.node.js";
import { FakeLlmClient } from "../../../../src/agent/llm/fake.adapter.js";
import { FakeAuditLog } from "../../../../src/compliance/audit-log.fake.js";
import { StaticAirlineDirectoryAdapter } from "../../../../src/providers/airline-directory/static.adapter.js";
import {
  buildAnyCodeEmailAirlineDirectory,
  buildAnyCodeWebFormAirlineDirectory,
} from "../../../../src/providers/airline-directory/fake.adapter.js";
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

/** Real dataset — every carrier in it is a web form, so this exercises the
 * packet/refusal paths, not the letter path. */
function buildDeps() {
  return { llm: new FakeLlmClient(), airlineDirectory: new StaticAirlineDirectoryAdapter(), auditLog: new FakeAuditLog() };
}

/** An email carrier, which is the only kind that reaches the LLM letter path.
 * No real carrier qualifies today (see fake.adapter.ts), so this is a stub. */
function buildLetterDeps() {
  return { llm: new FakeLlmClient(), airlineDirectory: buildAnyCodeEmailAirlineDirectory(), auditLog: new FakeAuditLog() };
}

describe("draft-claim node", () => {
  it("drafts using the original-claim prompt when there's no prior rejection", async () => {
    const deps = buildLetterDeps();
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
    const deps = buildLetterDeps();
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

describe("draft-claim node — submission plan", () => {
  it("refuses to draft anything for a carrier with no usable channel (real directory data)", async () => {
    // Iberia's only recorded channel is unverified, so there is nothing to
    // submit to. This is the incident case: an unsupported carrier used to fall
    // through to the letter path and the model wrote a full formal claim for an
    // airline with nowhere to send it, inventing a booking reference on the way.
    const deps = buildDeps();
    const node = createDraftClaimNode(deps);

    const result = await node(
      buildState({
        booking: BOOKING,
        flightStatuses: [{ ...FLIGHT_STATUS, operatingCarrierIataCode: "IB" }],
        compensationCents: 60000,
      }),
    );

    expect(deps.llm.calls).toHaveLength(0);
    expect(result.draftText).toBeNull();
    expect(result.submission?.selection.type).toBe("none_available");
    expect(result.submission?.message).toContain("haven't been able to confirm");
  });

  it("refuses to draft anything for a carrier with no directory entry at all", async () => {
    const deps = buildDeps();
    const node = createDraftClaimNode(deps);

    const result = await node(
      buildState({
        booking: BOOKING,
        flightStatuses: [{ ...FLIGHT_STATUS, operatingCarrierIataCode: "ZZ" }],
        compensationCents: 60000,
      }),
    );

    expect(deps.llm.calls).toHaveLength(0);
    expect(result.draftText).toBeNull();
    expect(result.submission?.message).toContain("isn't supported at the moment");
  });

  it("exposes an auto-sendable channel when the carrier accepts claims by email", async () => {
    const deps = { llm: new FakeLlmClient(), airlineDirectory: buildAnyCodeEmailAirlineDirectory(), auditLog: new FakeAuditLog() };
    deps.llm.enqueueJson({ letterText: "Dear Lufthansa, ..." });
    const node = createDraftClaimNode(deps);

    const result = await node(
      buildState({ booking: BOOKING, flightStatuses: [FLIGHT_STATUS], compensationCents: 60000 }),
    );

    expect(result.submission?.autoSendChannel).not.toBeNull();
    expect(result.draftText).toContain("Dear Lufthansa");
  });

  it("surfaces a third-party restriction and refuses auto-send for it (real Ryanair data)", async () => {
    const deps = buildDeps();
    const node = createDraftClaimNode(deps);

    const result = await node(
      buildState({
        booking: BOOKING,
        flightStatuses: [{ ...FLIGHT_STATUS, operatingCarrierIataCode: "FR" }],
        compensationCents: 60000,
      }),
    );

    expect(result.submission?.thirdPartySubmission).toBe("restricted");
    expect(result.submission?.autoSendChannel).toBeNull();
    expect(result.submission?.message).toContain("filed by the passenger directly");
  });
});

describe("draft-claim node — web-form carriers get a submission packet, not a letter", () => {
  it("builds a deterministic packet with the link and claim facts, without calling the LLM", async () => {
    const deps = {
      llm: new FakeLlmClient(),
      airlineDirectory: buildAnyCodeWebFormAirlineDirectory(["claimantFullName", "payoutIban"]),
      auditLog: new FakeAuditLog(),
    };
    const node = createDraftClaimNode(deps);

    const result = await node(
      buildState({
        booking: BOOKING,
        flightStatuses: [FLIGHT_STATUS],
        compensationCents: 60000,
        eligibilityReason: "Arrival delay of 220 minute(s) meets the 180-minute threshold.",
      }),
    );

    expect(deps.llm.calls).toHaveLength(0);
    expect(result.draftText).toContain("https://airline.example.test/claims");
    expect(result.draftText).toContain("ABC123"); // booking reference
    expect(result.draftText).toContain("Jane Doe");
    expect(result.draftText).toContain("LH456");
    expect(result.draftText).toContain("€600");
    expect(result.draftText).toContain("full name");
    expect(result.draftText).toContain("IBAN");
    expect(result.submission?.selection.type).toBe("single");
    expect(deps.auditLog.entries).toHaveLength(1);
    expect(deps.auditLog.entries[0]?.entryType).toBe("system_action");
  });

  it("says so explicitly when nobody has catalogued the form's required fields", async () => {
    // Distinct from "the form asks for nothing" — claiming the latter about a
    // form that demands eight fields would be its own kind of confidently wrong.
    const deps = {
      llm: new FakeLlmClient(),
      airlineDirectory: buildAnyCodeWebFormAirlineDirectory(null),
      auditLog: new FakeAuditLog(),
    };
    const node = createDraftClaimNode(deps);

    const result = await node(
      buildState({ booking: BOOKING, flightStatuses: [FLIGHT_STATUS], compensationCents: 60000 }),
    );

    expect(result.draftText).toContain("haven't been able to catalogue");
  });

  it("still uses the LLM-drafted letter path for a rebuttal, even for a web-form carrier (unreachable today, but must fail safe)", async () => {
    const deps = {
      llm: new FakeLlmClient(),
      airlineDirectory: buildAnyCodeWebFormAirlineDirectory(),
      auditLog: new FakeAuditLog(),
    };
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

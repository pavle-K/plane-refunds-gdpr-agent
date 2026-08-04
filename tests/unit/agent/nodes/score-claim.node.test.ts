import { describe, it, expect } from "vitest";
import { createScoreClaimNode } from "../../../../src/agent/nodes/score-claim.node.js";
import { FakeWeatherAdapter, buildClearSkyObservation } from "../../../../src/providers/weather/fake.adapter.js";
import { FakeDisruptionAdapter } from "../../../../src/providers/disruption/fake.adapter.js";
import { FakeLlmClient } from "../../../../src/agent/llm/fake.js";
import { FakeAuditLog } from "../../../../src/compliance/audit-log.fake.js";
import { ok } from "../../../../src/lib/result.js";
import { buildState } from "../../../helpers/build-state.js";
import type { Booking } from "../../../../src/domain/claim/claim.types.js";
import type { FlightStatusResult } from "../../../../src/providers/flight-status/flight-status.port.js";

const BOOKING: Booking = {
  bookingReference: "ABC123",
  passengers: [{ id: "p1", fullName: "Jane Doe", email: "jane@example.com" }],
  flightNumber: "LH456",
  operatingCarrierCode: "LH",
  scheduledDepartureUtc: "2024-06-15T09:00:00.000Z",
  scheduledArrivalUtc: "2024-06-15T18:00:00.000Z",
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
  return {
    weather: new FakeWeatherAdapter(),
    disruption: new FakeDisruptionAdapter(),
    llm: new FakeLlmClient(),
    auditLog: new FakeAuditLog(),
  };
}

describe("score-claim node", () => {
  it("gathers weather + disruption evidence, calls the LLM, and audit-logs the output", async () => {
    const deps = buildDeps();
    deps.weather.seed(
      { icaoCode: "EDDF", atUtc: FLIGHT_STATUS.scheduledDepartureUtc },
      ok(buildClearSkyObservation({ icaoCode: "EDDF" })),
    );
    deps.llm.enqueueJson({
      successLikelihood: 0.8,
      confidence: 0.7,
      reasoning: "Clear skies rule out weather as an extraordinary circumstance.",
      citedEvidence: ["METAR showed clear conditions"],
    });

    const node = createScoreClaimNode(deps);
    const state = buildState({ booking: BOOKING, flightStatus: FLIGHT_STATUS, eligible: true, compensationCents: 60000 });

    const result = await node(state);

    expect(result.weatherObservation?.icaoCode).toBe("EDDF");
    expect(result.score?.successLikelihood).toBe(0.8);
    expect(deps.auditLog.entries).toHaveLength(1);
    expect(deps.auditLog.entries[0]?.entryType).toBe("llm_output");
  });

  it("proceeds without weather evidence when the airport reference is unknown", async () => {
    const deps = buildDeps();
    deps.llm.enqueueJson({ successLikelihood: 0.5, confidence: 0.5, reasoning: "r", citedEvidence: [] });

    const unknownAirportFlightStatus: FlightStatusResult = {
      ...FLIGHT_STATUS,
      departureAirportIata: "ZZZ",
    };
    const node = createScoreClaimNode(deps);
    const state = buildState({
      booking: BOOKING,
      flightStatus: unknownAirportFlightStatus,
      eligible: true,
      compensationCents: 60000,
    });

    const result = await node(state);

    expect(result.weatherObservation).toBeNull();
  });

  it("throws if booking or flightStatus is missing", async () => {
    const deps = buildDeps();
    const node = createScoreClaimNode(deps);
    await expect(node(buildState())).rejects.toThrow();
  });
});

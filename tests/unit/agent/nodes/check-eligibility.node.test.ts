import { describe, it, expect } from "vitest";
import { createCheckEligibilityNode } from "../../../../src/agent/nodes/check-eligibility.node.js";
import { FakeFlightStatusAdapter, buildOnTimeResult } from "../../../../src/providers/flight-status/fake.adapter.js";
import { StaticAirlineDirectoryAdapter } from "../../../../src/providers/airline-directory/static.adapter.js";
import { ok } from "../../../../src/lib/result.js";
import { buildState } from "../../../helpers/build-state.js";
import type { Booking } from "../../../../src/domain/claim/claim.types.js";

const BOOKING: Booking = {
  bookingReference: "ABC123",
  passengers: [{ id: "p1", fullName: "Jane Doe", email: "jane@example.com" }],
  flightNumber: "AF001",
  operatingCarrierCode: "AF",
  scheduledDepartureUtc: "2024-06-15T09:00:00.000Z",
  scheduledArrivalUtc: "2024-06-15T18:00:00.000Z",
};

const QUERY = { flightNumber: "AF001", scheduledDepartureDateUtc: "2024-06-15" };

function buildDeps() {
  return { flightStatus: new FakeFlightStatusAdapter(), airlineDirectory: new StaticAirlineDirectoryAdapter() };
}

describe("check-eligibility node", () => {
  it("marks a long delay from an EU departure airport eligible, and computes compensation", async () => {
    const deps = buildDeps();
    deps.flightStatus.seed(
      QUERY,
      ok(
        buildOnTimeResult({
          departureAirportIata: "CDG",
          arrivalAirportIata: "JFK",
          status: "delayed",
          delayMinutesAtArrival: 220,
        }),
      ),
    );
    const node = createCheckEligibilityNode(deps);

    const result = await node(buildState({ booking: BOOKING }));

    expect(result.eligible).toBe(true);
    expect(result.compensationCents).toBe(60000); // CDG-JFK is long-haul
  });

  it("marks an on-time flight ineligible without calling domain eligibility on nonsense input", async () => {
    const deps = buildDeps();
    deps.flightStatus.seed(QUERY, ok(buildOnTimeResult({ status: "on_time" })));
    const node = createCheckEligibilityNode(deps);

    const result = await node(buildState({ booking: BOOKING }));

    expect(result.eligible).toBe(false);
  });

  it("marks ineligible (not a crash) when the flight-status lookup fails", async () => {
    const deps = buildDeps(); // nothing seeded → fake adapter returns not_found
    const node = createCheckEligibilityNode(deps);

    const result = await node(buildState({ booking: BOOKING }));

    expect(result.eligible).toBe(false);
    expect(result.eligibilityReason).toContain("not_found");
  });

  it("marks a cancellation with unknown notice period ineligible, flagged for manual review, rather than guessing", async () => {
    const deps = buildDeps();
    deps.flightStatus.seed(
      QUERY,
      ok(buildOnTimeResult({ status: "cancelled", cancellationNoticeDays: null })),
    );
    const node = createCheckEligibilityNode(deps);

    const result = await node(buildState({ booking: BOOKING }));

    expect(result.eligible).toBe(false);
    expect(result.eligibilityReason).toContain("manual review");
  });

  it("does not cover a non-EU departure on a non-EU carrier arriving outside the EU", async () => {
    const deps = buildDeps();
    deps.flightStatus.seed(
      QUERY,
      ok(
        buildOnTimeResult({
          departureAirportIata: "JFK",
          arrivalAirportIata: "LAX",
          status: "delayed",
          delayMinutesAtArrival: 300,
        }),
      ),
    );
    const node = createCheckEligibilityNode(deps);

    const result = await node(buildState({ booking: BOOKING }));

    expect(result.eligible).toBe(false);
  });
});

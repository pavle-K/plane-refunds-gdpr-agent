import { describe, it, expect } from "vitest";
import { createCheckEligibilityNode } from "../../../../src/agent/nodes/check-eligibility.node.js";
import { FakeFlightStatusAdapter, buildOnTimeResult } from "../../../../src/providers/flight-status/fake.adapter.js";
import { StaticAirlineDirectoryAdapter } from "../../../../src/providers/airline-directory/static.adapter.js";
import { FakeAirportReferenceAdapter, buildAirportFacts } from "../../../../src/providers/airport-reference/fake.adapter.js";
import type { AirportFacts } from "../../../../src/providers/airport-reference/airport-reference.port.js";
import { ok } from "../../../../src/lib/result.js";
import { buildState } from "../../../helpers/build-state.js";
import type { Booking } from "../../../../src/domain/claim/claim.types.js";

/** Real coordinates/country codes for the handful of airports these tests
 * exercise — seeded into the fake provider so the pure distance/eligibility
 * math behaves exactly as it would against real data. */
function buildAirportReference(): FakeAirportReferenceAdapter {
  const adapter = new FakeAirportReferenceAdapter();
  const seed = (facts: AirportFacts) => adapter.seed(facts.iataCode, ok(buildAirportFacts(facts)));
  seed({ iataCode: "LHR", icaoCode: "EGLL", name: "London Heathrow", countryIsoCode: "GB", latitude: 51.47, longitude: -0.4543 });
  seed({ iataCode: "JFK", icaoCode: "KJFK", name: "John F Kennedy Intl", countryIsoCode: "US", latitude: 40.6413, longitude: -73.7781 });
  seed({ iataCode: "CDG", icaoCode: "LFPG", name: "Paris Charles de Gaulle", countryIsoCode: "FR", latitude: 49.0097, longitude: 2.5479 });
  seed({ iataCode: "LAX", icaoCode: "KLAX", name: "Los Angeles Intl", countryIsoCode: "US", latitude: 33.9416, longitude: -118.4085 });
  seed({ iataCode: "CGK", icaoCode: "WIII", name: "Soekarno-Hatta Intl", countryIsoCode: "ID", latitude: -6.1256, longitude: 106.6558 });
  seed({ iataCode: "VCE", icaoCode: "LIPZ", name: "Venice Marco Polo", countryIsoCode: "IT", latitude: 45.5053, longitude: 12.3519 });
  return adapter;
}

const BOOKING: Booking = {
  bookingReference: "ABC123",
  passengers: [{ id: "p1", fullName: "Jane Doe", email: "jane@example.com" }],
  segments: [
    {
      flightNumber: "AF001",
      operatingCarrierCode: "AF",
      scheduledDepartureUtc: "2024-06-15T09:00:00.000Z",
      scheduledArrivalUtc: "2024-06-15T18:00:00.000Z",
    },
  ],
};

const QUERY = { flightNumber: "AF001", scheduledDepartureDateUtc: "2024-06-15" };

function buildDeps() {
  return {
    flightStatus: new FakeFlightStatusAdapter(),
    airlineDirectory: new StaticAirlineDirectoryAdapter(),
    airportReference: buildAirportReference(),
  };
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

describe("check-eligibility node — connecting itineraries (Folkerts v Air France, C-11/11)", () => {
  // Carrier is LH (EU) here deliberately, to isolate the final-arrival-delay
  // logic from the route-coverage question — coverage is tested separately
  // above, and again below with the real (non-EU-carrier) scenario.
  const CONNECTING_BOOKING: Booking = {
    bookingReference: "MYTRIP-1119-971-928",
    passengers: [{ id: "p1", fullName: "Pavle Kerkez", email: "" }],
    segments: [
      {
        flightNumber: "LH1867",
        operatingCarrierCode: "LH",
        scheduledDepartureUtc: "2026-05-25T21:00:00.000Z",
        scheduledArrivalUtc: "2026-05-26T02:00:00.000Z",
      },
      {
        flightNumber: "LH57",
        operatingCarrierCode: "LH",
        scheduledDepartureUtc: "2026-05-26T03:30:00.000Z",
        scheduledArrivalUtc: "2026-05-26T05:20:00.000Z",
      },
    ],
  };
  const LEG1_QUERY = { flightNumber: "LH1867", scheduledDepartureDateUtc: "2026-05-25" };
  const LEG2_QUERY = { flightNumber: "LH57", scheduledDepartureDateUtc: "2026-05-26" };

  it("is NOT eligible when the first leg is delayed but the final arrival is still on time", async () => {
    const deps = buildDeps();
    // Leg 1 departed late, but the connection was made and leg 2 still landed on schedule.
    deps.flightStatus.seed(
      LEG1_QUERY,
      ok(buildOnTimeResult({ departureAirportIata: "CGK", arrivalAirportIata: "IST", status: "delayed", delayMinutesAtArrival: 90 })),
    );
    deps.flightStatus.seed(
      LEG2_QUERY,
      ok(buildOnTimeResult({ departureAirportIata: "IST", arrivalAirportIata: "VCE", status: "on_time", delayMinutesAtArrival: null })),
    );
    const node = createCheckEligibilityNode(deps);

    const result = await node(buildState({ booking: CONNECTING_BOOKING }));

    expect(result.eligible).toBe(false);
  });

  it("IS eligible for the WHOLE itinerary when a delay causes the FINAL arrival to be 3+ hours late", async () => {
    const deps = buildDeps();
    deps.flightStatus.seed(
      LEG1_QUERY,
      ok(buildOnTimeResult({ departureAirportIata: "CGK", arrivalAirportIata: "IST", status: "delayed", delayMinutesAtArrival: 240 })),
    );
    deps.flightStatus.seed(
      LEG2_QUERY,
      ok(buildOnTimeResult({ operatingCarrierIataCode: "LH", departureAirportIata: "IST", arrivalAirportIata: "VCE", status: "delayed", delayMinutesAtArrival: 220 })),
    );
    const node = createCheckEligibilityNode(deps);

    const result = await node(buildState({ booking: CONNECTING_BOOKING }));

    expect(result.eligible).toBe(true);
    // Direct Jakarta(CGK)→Venice(VCE) distance, not the Istanbul-Venice leg alone.
    expect(result.compensationCents).toBe(60000);
  });

  it("treats the itinerary as cancelled if ANY segment is cancelled", async () => {
    const deps = buildDeps();
    deps.flightStatus.seed(
      LEG1_QUERY,
      ok(buildOnTimeResult({ departureAirportIata: "CGK", arrivalAirportIata: "IST", status: "cancelled", cancellationNoticeDays: 2 })),
    );
    deps.flightStatus.seed(
      LEG2_QUERY,
      ok(buildOnTimeResult({ operatingCarrierIataCode: "LH", departureAirportIata: "IST", arrivalAirportIata: "VCE", status: "on_time", delayMinutesAtArrival: null })),
    );
    const node = createCheckEligibilityNode(deps);

    const result = await node(buildState({ booking: CONNECTING_BOOKING }));

    expect(result.eligible).toBe(true);
    expect(result.eligibilityReason).toContain("day(s)");
  });

  it("reports which segment failed when a lookup for one leg fails", async () => {
    const deps = buildDeps();
    deps.flightStatus.seed(
      LEG1_QUERY,
      ok(buildOnTimeResult({ departureAirportIata: "CGK", arrivalAirportIata: "IST", status: "on_time" })),
    );
    // LEG2_QUERY intentionally not seeded — fake adapter returns not_found.
    const node = createCheckEligibilityNode(deps);

    const result = await node(buildState({ booking: CONNECTING_BOOKING }));

    expect(result.eligible).toBe(false);
    expect(result.eligibilityReason).toContain("segment 2");
  });

  it("REAL-WORLD CASE: Jakarta→Venice via Turkish Airlines is NOT covered, no matter the delay — non-EU departure and a non-EU operating carrier arriving in the EU", async () => {
    // This mirrors an actual booking investigated during development. Even a
    // massive final-arrival delay doesn't help: Article 3(1)(a) needs an EU
    // departure (Jakarta isn't), and 3(1)(b) needs an EU carrier for arrival
    // into the EU from a third country (Turkish Airlines isn't one — Turkey
    // is not an EU member state).
    const realBooking: Booking = {
      bookingReference: "1119-971-928",
      passengers: [{ id: "p1", fullName: "Pavle Kerkez", email: "" }],
      segments: [
        {
          flightNumber: "TK1867",
          operatingCarrierCode: "TK",
          scheduledDepartureUtc: "2026-05-25T21:00:00.000Z",
          scheduledArrivalUtc: "2026-05-26T02:00:00.000Z",
        },
        {
          flightNumber: "TK57",
          operatingCarrierCode: "TK",
          scheduledDepartureUtc: "2026-05-26T03:30:00.000Z",
          scheduledArrivalUtc: "2026-05-26T05:20:00.000Z",
        },
      ],
    };

    const deps = buildDeps();
    deps.flightStatus.seed(
      { flightNumber: "TK1867", scheduledDepartureDateUtc: "2026-05-25" },
      ok(buildOnTimeResult({ departureAirportIata: "CGK", arrivalAirportIata: "IST", status: "delayed", delayMinutesAtArrival: 300 })),
    );
    deps.flightStatus.seed(
      { flightNumber: "TK57", scheduledDepartureDateUtc: "2026-05-26" },
      ok(buildOnTimeResult({ departureAirportIata: "IST", arrivalAirportIata: "VCE", status: "delayed", delayMinutesAtArrival: 280 })),
    );
    const node = createCheckEligibilityNode(deps);

    const result = await node(buildState({ booking: realBooking }));

    expect(result.eligible).toBe(false);
    expect(result.eligibilityReason).toContain("not covered");
  });
});

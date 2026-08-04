import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AeroApiFlightStatusAdapter } from "../../../../src/providers/flight-status/aeroapi.adapter.js";

/**
 * These fixtures are a best-effort reconstruction of AeroAPI v4's documented
 * response shape, NOT captured from a real call (no API key available yet — see
 * the adapter's file header). Re-record real fixtures once a key is available and
 * re-run this suite to confirm the mapping still holds.
 */
function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../../fixtures/flights/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

function mockFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AeroApiFlightStatusAdapter — parsing", () => {
  it("maps a delayed flight, computing delay on ARRIVAL (gate time)", async () => {
    mockFetchOnce(loadFixture("delayed.json"));
    const adapter = new AeroApiFlightStatusAdapter("fake-key");

    const result = await adapter.getFlightStatus({
      flightNumber: "BA123",
      scheduledDepartureDateUtc: "2024-06-15",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("delayed");
      expect(result.value.delayMinutesAtArrival).toBe(190);
      expect(result.value.operatingCarrierIataCode).toBe("BA");
      expect(result.value.departureAirportIata).toBe("LHR");
      expect(result.value.arrivalAirportIata).toBe("JFK");
    }
  });

  it("maps an on-time flight (negative raw delay clamped to 0)", async () => {
    mockFetchOnce(loadFixture("on-time.json"));
    const adapter = new AeroApiFlightStatusAdapter("fake-key");

    const result = await adapter.getFlightStatus({
      flightNumber: "AF200",
      scheduledDepartureDateUtc: "2024-06-15",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("on_time");
      expect(result.value.delayMinutesAtArrival).toBe(0);
    }
  });

  it("maps a cancelled flight without a delay figure", async () => {
    mockFetchOnce(loadFixture("cancelled.json"));
    const adapter = new AeroApiFlightStatusAdapter("fake-key");

    const result = await adapter.getFlightStatus({
      flightNumber: "LH456",
      scheduledDepartureDateUtc: "2024-07-01",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("cancelled");
      expect(result.value.delayMinutesAtArrival).toBeNull();
      expect(result.value.cancellationNoticeDays).toBeNull();
    }
  });
});

describe("AeroApiFlightStatusAdapter — failure modes", () => {
  it("returns not_found when the flights array is empty", async () => {
    mockFetchOnce({ flights: [] });
    const adapter = new AeroApiFlightStatusAdapter("fake-key");

    const result = await adapter.getFlightStatus({
      flightNumber: "ZZ999",
      scheduledDepartureDateUtc: "2024-01-01",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("returns not_found on an explicit HTTP 404", async () => {
    mockFetchOnce(null, 404);
    const adapter = new AeroApiFlightStatusAdapter("fake-key");

    const result = await adapter.getFlightStatus({
      flightNumber: "ZZ999",
      scheduledDepartureDateUtc: "2024-01-01",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("returns auth_error on HTTP 401", async () => {
    mockFetchOnce(null, 401);
    const adapter = new AeroApiFlightStatusAdapter("bad-key");

    const result = await adapter.getFlightStatus({
      flightNumber: "BA123",
      scheduledDepartureDateUtc: "2024-06-15",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("auth_error");
    }
  });

  it("returns rate_limited on HTTP 429", async () => {
    mockFetchOnce(null, 429);
    const adapter = new AeroApiFlightStatusAdapter("fake-key");

    const result = await adapter.getFlightStatus({
      flightNumber: "BA123",
      scheduledDepartureDateUtc: "2024-06-15",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("rate_limited");
    }
  });

  it("returns upstream_error on a 5xx response", async () => {
    mockFetchOnce(null, 503);
    const adapter = new AeroApiFlightStatusAdapter("fake-key");

    const result = await adapter.getFlightStatus({
      flightNumber: "BA123",
      scheduledDepartureDateUtc: "2024-06-15",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });

  it("returns upstream_error rather than a partial object when required fields are missing", async () => {
    mockFetchOnce({ flights: [{ ident_iata: "BA123", origin: null, destination: null }] });
    const adapter = new AeroApiFlightStatusAdapter("fake-key");

    const result = await adapter.getFlightStatus({
      flightNumber: "BA123",
      scheduledDepartureDateUtc: "2024-06-15",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });

  it("returns upstream_error on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const adapter = new AeroApiFlightStatusAdapter("fake-key");

    const result = await adapter.getFlightStatus({
      flightNumber: "BA123",
      scheduledDepartureDateUtc: "2024-06-15",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });
});

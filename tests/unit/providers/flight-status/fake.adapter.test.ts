import { describe, it, expect } from "vitest";
import { FakeFlightStatusAdapter, buildOnTimeResult } from "../../../../src/providers/flight-status/fake.adapter.js";
import { ok, err } from "../../../../src/lib/result.js";

describe("FakeFlightStatusAdapter", () => {
  it("returns the seeded result for a matching query", async () => {
    const adapter = new FakeFlightStatusAdapter();
    const query = { flightNumber: "BA123", scheduledDepartureDateUtc: "2024-06-15" };
    const seededValue = buildOnTimeResult({ status: "delayed", delayMinutesAtArrival: 200 });
    adapter.seed(query, ok(seededValue));

    const result = await adapter.getFlightStatus(query);
    expect(result).toEqual(ok(seededValue));
  });

  it("is case-insensitive on flight number", async () => {
    const adapter = new FakeFlightStatusAdapter();
    const seededValue = buildOnTimeResult();
    adapter.seed({ flightNumber: "BA123", scheduledDepartureDateUtc: "2024-06-15" }, ok(seededValue));

    const result = await adapter.getFlightStatus({
      flightNumber: "ba123",
      scheduledDepartureDateUtc: "2024-06-15",
    });
    expect(result).toEqual(ok(seededValue));
  });

  it("returns a typed not_found error for an unseeded query, never a partial object", async () => {
    const adapter = new FakeFlightStatusAdapter();
    const result = await adapter.getFlightStatus({
      flightNumber: "ZZ999",
      scheduledDepartureDateUtc: "2024-01-01",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("can be seeded with a typed error to simulate upstream failure modes", async () => {
    const adapter = new FakeFlightStatusAdapter();
    const query = { flightNumber: "BA123", scheduledDepartureDateUtc: "2024-06-15" };
    adapter.seed(query, err({ type: "rate_limited", message: "429" }));

    const result = await adapter.getFlightStatus(query);
    expect(result).toEqual(err({ type: "rate_limited", message: "429" }));
  });
});

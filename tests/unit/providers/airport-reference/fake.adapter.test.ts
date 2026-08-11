import { describe, it, expect } from "vitest";
import { FakeAirportReferenceAdapter, buildAirportFacts } from "../../../../src/providers/airport-reference/fake.adapter.js";
import { ok } from "../../../../src/lib/result.js";

describe("FakeAirportReferenceAdapter", () => {
  it("returns a seeded result", async () => {
    const adapter = new FakeAirportReferenceAdapter();
    adapter.seed("PMO", ok(buildAirportFacts({ iataCode: "PMO", countryIsoCode: "IT" })));

    const result = await adapter.getAirport("PMO");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.countryIsoCode).toBe("IT");
    }
  });

  it("is case-insensitive on the IATA code", async () => {
    const adapter = new FakeAirportReferenceAdapter();
    adapter.seed("PMO", ok(buildAirportFacts({ iataCode: "PMO" })));

    const result = await adapter.getAirport("pmo");

    expect(result.ok).toBe(true);
  });

  it("returns not_found for an unseeded code, never a fabricated default", async () => {
    const adapter = new FakeAirportReferenceAdapter();

    const result = await adapter.getAirport("ZZZ");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });
});

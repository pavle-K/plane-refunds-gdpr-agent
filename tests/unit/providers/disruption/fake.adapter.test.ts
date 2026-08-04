import { describe, it, expect } from "vitest";
import { FakeDisruptionAdapter } from "../../../../src/providers/disruption/fake.adapter.js";
import { ok, err } from "../../../../src/lib/result.js";
import type { DisruptionEvent } from "../../../../src/providers/disruption/disruption.port.js";

describe("FakeDisruptionAdapter", () => {
  it("returns an empty array (not an error) for an unseeded query", async () => {
    const adapter = new FakeDisruptionAdapter();
    const result = await adapter.getDisruptions({ airportIata: "LHR", dateUtc: "2024-06-15" });
    expect(result).toEqual(ok([]));
  });

  it("returns seeded disruption events", async () => {
    const adapter = new FakeDisruptionAdapter();
    const event: DisruptionEvent = {
      airportIata: "CDG",
      dateUtc: "2024-06-15",
      causeCode: "atc_strike",
      description: "French ATC strike",
      source: "test-fixture",
    };
    adapter.seed({ airportIata: "CDG", dateUtc: "2024-06-15" }, ok([event]));

    const result = await adapter.getDisruptions({ airportIata: "CDG", dateUtc: "2024-06-15" });
    expect(result).toEqual(ok([event]));
  });

  it("can be seeded with a typed error", async () => {
    const adapter = new FakeDisruptionAdapter();
    const query = { airportIata: "CDG", dateUtc: "2024-06-15" };
    adapter.seed(query, err({ type: "upstream_error", message: "boom" }));

    const result = await adapter.getDisruptions(query);
    expect(result).toEqual(err({ type: "upstream_error", message: "boom" }));
  });
});

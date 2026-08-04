import { describe, it, expect } from "vitest";
import { FakeWeatherAdapter, buildClearSkyObservation } from "../../../../src/providers/weather/fake.adapter.js";
import { ok, err } from "../../../../src/lib/result.js";

describe("FakeWeatherAdapter", () => {
  it("returns the seeded observation for a matching query", async () => {
    const adapter = new FakeWeatherAdapter();
    const query = { icaoCode: "EGLL", atUtc: "2024-06-15T10:00:00.000Z" };
    const observation = buildClearSkyObservation({ thunderstorm: true });
    adapter.seed(query, ok(observation));

    const result = await adapter.getObservation(query);
    expect(result).toEqual(ok(observation));
  });

  it("returns a typed not_found error for an unseeded query", async () => {
    const adapter = new FakeWeatherAdapter();
    const result = await adapter.getObservation({ icaoCode: "ZZZZ", atUtc: "2024-01-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("can be seeded with a typed error", async () => {
    const adapter = new FakeWeatherAdapter();
    const query = { icaoCode: "EGLL", atUtc: "2024-06-15T10:00:00.000Z" };
    adapter.seed(query, err({ type: "upstream_error", message: "boom" }));

    const result = await adapter.getObservation(query);
    expect(result).toEqual(err({ type: "upstream_error", message: "boom" }));
  });
});

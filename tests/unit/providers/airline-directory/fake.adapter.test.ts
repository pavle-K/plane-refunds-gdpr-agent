import { describe, it, expect } from "vitest";
import { FakeAirlineDirectoryAdapter, buildAirlineClaimsContact, buildAnyCodeEmailAirlineDirectory } from "../../../../src/providers/airline-directory/fake.adapter.js";
import { ok } from "../../../../src/lib/result.js";

describe("FakeAirlineDirectoryAdapter", () => {
  it("returns a seeded result", async () => {
    const adapter = new FakeAirlineDirectoryAdapter();
    adapter.seed("FR", ok(buildAirlineClaimsContact({ carrierIataCode: "FR", carrierName: "Ryanair" })));

    const result = await adapter.getAirline("FR");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.carrierName).toBe("Ryanair");
    }
  });

  it("is case-insensitive on carrier code", async () => {
    const adapter = new FakeAirlineDirectoryAdapter();
    adapter.seed("FR", ok(buildAirlineClaimsContact({ carrierIataCode: "FR" })));

    const result = await adapter.getAirline("fr");

    expect(result.ok).toBe(true);
  });

  it("returns not_found for an unseeded carrier, never a fabricated default", async () => {
    const adapter = new FakeAirlineDirectoryAdapter();

    const result = await adapter.getAirline("ZZ");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("listAirlines returns only the successfully-seeded entries, not the not_found ones", async () => {
    const adapter = new FakeAirlineDirectoryAdapter();
    adapter.seed("FR", ok(buildAirlineClaimsContact({ carrierIataCode: "FR", carrierName: "Ryanair" })));
    adapter.seed("ZZ", { ok: false, error: { type: "not_found", message: "no fixture" } });

    const all = await adapter.listAirlines();

    expect(all).toHaveLength(1);
    expect(all[0]?.carrierIataCode).toBe("FR");
  });
});

describe("buildAnyCodeEmailAirlineDirectory", () => {
  it("resolves any carrier code to a working email submission method", async () => {
    const directory = buildAnyCodeEmailAirlineDirectory();

    const result = await directory.getAirline("XX");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channels[0]?.kind).toBe("email");
      expect(result.value.carrierIataCode).toBe("XX");
    }
  });
});

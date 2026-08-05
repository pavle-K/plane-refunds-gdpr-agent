import { describe, it, expect } from "vitest";
import { StaticAirlineDirectoryAdapter } from "../../../../src/providers/airline-directory/static.adapter.js";

describe("StaticAirlineDirectoryAdapter", () => {
  it("returns a known EU carrier", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const result = await adapter.getAirline("LH");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.carrierName).toBe("Lufthansa");
      expect(result.value.isEuCarrier).toBe(true);
    }
  });

  it("returns a known non-EU carrier", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const result = await adapter.getAirline("BA");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.carrierName).toBe("British Airways");
      expect(result.value.isEuCarrier).toBe(false);
    }
  });

  it("is case-insensitive on carrier code", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const result = await adapter.getAirline("lh");
    expect(result.ok).toBe(true);
  });

  it("returns a typed not_found error for an unseeded carrier, never a partial object", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const result = await adapter.getAirline("ZZ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("flags every seeded claims email as an unverified placeholder, not a real address", async () => {
    // Guards against someone quietly "fixing" one entry with a guessed real address
    // instead of sourcing it properly — every entry must go through the same review.
    const adapter = new StaticAirlineDirectoryAdapter();
    for (const code of ["LH", "AF", "KL", "IB", "AZ", "FR", "EI", "TP", "BA", "LX", "TK"]) {
      const result = await adapter.getAirline(code);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.claimsEmail).toContain("REPLACE-ME");
      }
    }
  });
});

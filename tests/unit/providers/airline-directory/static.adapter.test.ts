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

  it("marks entries with no sourced/verified channel as unsupported, never a guessed one", async () => {
    // Guards against someone quietly "fixing" one of these with a guessed real
    // address or form URL instead of actually sourcing and verifying it —
    // these must stay unsupported until someone does that properly.
    const adapter = new StaticAirlineDirectoryAdapter();
    for (const code of ["LH", "AF", "KL", "IB", "AZ", "FR", "BA", "LX", "TK"]) {
      const result = await adapter.getAirline(code);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.submissionMethod.type).toBe("unsupported");
      }
    }
  });

  it("exposes a sourced/verified web_form channel for carriers that have one", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    for (const code of ["EI", "TP"]) {
      const result = await adapter.getAirline(code);
      expect(result.ok).toBe(true);
      if (result.ok && result.value.submissionMethod.type === "web_form") {
        expect(result.value.submissionMethod.formUrl).toMatch(/^https:\/\//);
      } else {
        expect.fail(`${code} should have a web_form submissionMethod`);
      }
    }
  });

  it("listAirlines returns every entry, matching individual getAirline lookups", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const all = await adapter.listAirlines();

    expect(all).toHaveLength(11);
    expect(all.map((a) => a.carrierIataCode).sort()).toEqual(
      ["AF", "AZ", "BA", "EI", "FR", "IB", "KL", "LH", "LX", "TK", "TP"],
    );

    // No entry is "email" today — this is exactly the fact list_supported_airlines
    // exists to report accurately instead of the operator guessing.
    expect(all.every((a) => a.submissionMethod.type !== "email")).toBe(true);
  });
});

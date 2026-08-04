import { describe, it, expect } from "vitest";
import { getDistanceKm, UnknownAirportError } from "../../../../src/domain/ec261/distance.js";

describe("getDistanceKm", () => {
  it("computes known long-haul pairs within tolerance of published great-circle distances", () => {
    expect(getDistanceKm("LHR", "JFK")).toBeCloseTo(5540, -1); // within ~10km
    expect(getDistanceKm("CDG", "DXB")).toBeCloseTo(5239, -1);
    expect(getDistanceKm("LAX", "SYD")).toBeCloseTo(12061, -1);
  });

  it("computes known short-haul pairs within tolerance", () => {
    expect(getDistanceKm("AMS", "BCN")).toBeCloseTo(1241, -1);
  });

  it("is symmetric", () => {
    expect(getDistanceKm("LHR", "JFK")).toBeCloseTo(getDistanceKm("JFK", "LHR"), 5);
  });

  it("returns 0 for the same airport", () => {
    expect(getDistanceKm("LHR", "LHR")).toBe(0);
  });

  it("is case-insensitive on IATA codes", () => {
    expect(getDistanceKm("lhr", "jfk")).toBeCloseTo(getDistanceKm("LHR", "JFK"), 5);
  });

  it("throws UnknownAirportError for an unrecognized IATA code, never a silent 0", () => {
    expect(() => getDistanceKm("ZZZ", "JFK")).toThrow(UnknownAirportError);
    expect(() => getDistanceKm("LHR", "ZZZ")).toThrow(UnknownAirportError);
  });

  it("computes an antimeridian-crossing route correctly (LAX–SYD great circle runs via the Pacific)", () => {
    const distance = getDistanceKm("LAX", "SYD");
    // A naive flat/linear longitude-difference implementation would produce a wildly
    // different (much larger) number here since |−118.4 − 151.2| ≈ 270°, not ~90°.
    expect(distance).toBeGreaterThan(11000);
    expect(distance).toBeLessThan(13000);
  });
});

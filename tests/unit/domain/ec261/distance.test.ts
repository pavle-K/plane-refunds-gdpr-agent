import { describe, it, expect } from "vitest";
import { getDistanceKm, type Coordinates } from "../../../../src/domain/ec261/distance.js";

const LHR: Coordinates = { lat: 51.47, lon: -0.4543 };
const JFK: Coordinates = { lat: 40.6413, lon: -73.7781 };
const CDG: Coordinates = { lat: 49.0097, lon: 2.5479 };
const DXB: Coordinates = { lat: 25.2532, lon: 55.3657 };
const LAX: Coordinates = { lat: 33.9416, lon: -118.4085 };
const SYD: Coordinates = { lat: -33.9399, lon: 151.1753 };
const AMS: Coordinates = { lat: 52.3105, lon: 4.7683 };
const BCN: Coordinates = { lat: 41.2971, lon: 2.0785 };

describe("getDistanceKm", () => {
  it("computes known long-haul pairs within tolerance of published great-circle distances", () => {
    expect(getDistanceKm(LHR, JFK)).toBeCloseTo(5540, -1); // within ~10km
    expect(getDistanceKm(CDG, DXB)).toBeCloseTo(5239, -1);
    expect(getDistanceKm(LAX, SYD)).toBeCloseTo(12061, -1);
  });

  it("computes known short-haul pairs within tolerance", () => {
    expect(getDistanceKm(AMS, BCN)).toBeCloseTo(1241, -1);
  });

  it("is symmetric", () => {
    expect(getDistanceKm(LHR, JFK)).toBeCloseTo(getDistanceKm(JFK, LHR), 5);
  });

  it("returns 0 for the same coordinates", () => {
    expect(getDistanceKm(LHR, LHR)).toBe(0);
  });

  it("computes an antimeridian-crossing route correctly (LAX–SYD great circle runs via the Pacific)", () => {
    const distance = getDistanceKm(LAX, SYD);
    // A naive flat/linear longitude-difference implementation would produce a wildly
    // different (much larger) number here since |−118.4 − 151.2| ≈ 270°, not ~90°.
    expect(distance).toBeGreaterThan(11000);
    expect(distance).toBeLessThan(13000);
  });
});

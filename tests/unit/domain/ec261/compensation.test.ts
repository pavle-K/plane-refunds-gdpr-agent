import { describe, it, expect } from "vitest";
import { getCompensationCents, InvalidDistanceError } from "../../../../src/domain/ec261/compensation.js";

describe("getCompensationCents", () => {
  it("returns €250 for short-haul (<= 1,500 km)", () => {
    expect(getCompensationCents(500)).toBe(25000);
    expect(getCompensationCents(1500)).toBe(25000);
  });

  it("returns €400 for medium-haul (1,501–3,500 km)", () => {
    expect(getCompensationCents(1501)).toBe(40000);
    expect(getCompensationCents(3500)).toBe(40000);
  });

  it("returns €600 for long-haul (> 3,500 km)", () => {
    expect(getCompensationCents(3501)).toBe(60000);
    expect(getCompensationCents(10000)).toBe(60000);
  });

  it("handles the exact short/medium boundary values", () => {
    expect(getCompensationCents(1499)).toBe(25000);
    expect(getCompensationCents(1500)).toBe(25000);
    expect(getCompensationCents(1501)).toBe(40000);
  });

  it("handles the exact medium/long boundary values", () => {
    expect(getCompensationCents(3499)).toBe(40000);
    expect(getCompensationCents(3500)).toBe(40000);
    expect(getCompensationCents(3501)).toBe(60000);
  });

  it("throws on negative, zero, and NaN distances rather than defaulting", () => {
    expect(() => getCompensationCents(-1)).toThrow(InvalidDistanceError);
    expect(() => getCompensationCents(0)).toThrow(InvalidDistanceError);
    expect(() => getCompensationCents(NaN)).toThrow(InvalidDistanceError);
    expect(() => getCompensationCents(Infinity)).toThrow(InvalidDistanceError);
  });

  it("always returns an integer number of cents", () => {
    for (const km of [1, 1500, 1501, 3500, 3501, 9999]) {
      expect(Number.isInteger(getCompensationCents(km))).toBe(true);
    }
  });
});

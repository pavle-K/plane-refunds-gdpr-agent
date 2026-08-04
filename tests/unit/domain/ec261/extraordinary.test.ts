import { describe, it, expect } from "vitest";
import { assessExtraordinaryCircumstance } from "../../../../src/domain/ec261/extraordinary.js";

describe("assessExtraordinaryCircumstance", () => {
  it("treats weather at/below operating minima as a valid defence", () => {
    expect(assessExtraordinaryCircumstance("weather_below_minima")).toBe("valid_defence");
  });

  it("treats an ATC strike as a valid defence", () => {
    expect(assessExtraordinaryCircumstance("atc_strike")).toBe("valid_defence");
  });

  it("treats a third-party (non-airline) staff strike as a valid defence", () => {
    expect(assessExtraordinaryCircumstance("third_party_staff_strike")).toBe("valid_defence");
  });

  it("does NOT treat the airline's own staff strike as a valid defence", () => {
    expect(assessExtraordinaryCircumstance("airline_staff_strike")).toBe("not_valid_defence");
  });

  it("does NOT treat a technical/mechanical fault as a valid defence in the general case", () => {
    expect(assessExtraordinaryCircumstance("technical_fault")).toBe("not_valid_defence");
  });

  it("returns 'unproven' for an unknown cause code, never defaulting to the airline's favor", () => {
    expect(assessExtraordinaryCircumstance("unknown")).toBe("unproven");
  });

  it("returns 'unproven' for an absent cause code", () => {
    expect(assessExtraordinaryCircumstance(undefined)).toBe("unproven");
    expect(assessExtraordinaryCircumstance(null)).toBe("unproven");
  });
});

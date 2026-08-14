import { describe, it, expect } from "vitest";
import { isEuMemberCountry } from "../../../../src/domain/ec261/eu-membership.js";

describe("isEuMemberCountry", () => {
  it("returns true for EU member states", () => {
    expect(isEuMemberCountry("DE")).toBe(true);
    expect(isEuMemberCountry("FR")).toBe(true);
    expect(isEuMemberCountry("IT")).toBe(true);
    expect(isEuMemberCountry("HR")).toBe(true); // Croatia — 2013 accession
  });

  it("returns false for the UK, post-Brexit", () => {
    expect(isEuMemberCountry("GB")).toBe(false);
  });

  it("returns false for non-EU EEA/wider-Europe states", () => {
    expect(isEuMemberCountry("CH")).toBe(false); // Switzerland
    expect(isEuMemberCountry("NO")).toBe(false); // Norway
  });

  it("returns false for non-European countries", () => {
    expect(isEuMemberCountry("US")).toBe(false);
    expect(isEuMemberCountry("TN")).toBe(false); // Tunisia
  });

  it("is case-insensitive", () => {
    expect(isEuMemberCountry("de")).toBe(true);
  });
});

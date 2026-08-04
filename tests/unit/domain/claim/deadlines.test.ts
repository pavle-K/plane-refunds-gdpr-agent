import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getLimitationDeadlineUtc,
  isPastLimitationDeadline,
  getAirlineResponseDeadlineUtc,
  hasAirlineTimedOut,
  UnknownJurisdictionError,
} from "../../../../src/domain/claim/deadlines.js";

describe("limitation period", () => {
  it("computes the deadline from the correct anchor date per jurisdiction", () => {
    const flightDateUtc = new Date(Date.UTC(2024, 5, 15)); // 2024-06-15
    const deadline = getLimitationDeadlineUtc({ countryCode: "DE", flightDateUtc });
    expect(deadline.toISOString()).toBe(new Date(Date.UTC(2027, 5, 15)).toISOString());
  });

  it("uses a different period for a different jurisdiction from the same anchor date", () => {
    const flightDateUtc = new Date(Date.UTC(2024, 5, 15));
    const deDeadline = getLimitationDeadlineUtc({ countryCode: "DE", flightDateUtc });
    const frDeadline = getLimitationDeadlineUtc({ countryCode: "FR", flightDateUtc });
    expect(deDeadline.getTime()).not.toBe(frDeadline.getTime());
  });

  it("flags a claim past its limitation period rather than silently filing it", () => {
    const flightDateUtc = new Date(Date.UTC(2020, 0, 1));
    const now = new Date(Date.UTC(2025, 0, 2)); // just past DE's 3-year period
    expect(isPastLimitationDeadline({ countryCode: "DE", flightDateUtc }, now)).toBe(true);
  });

  it("does not flag a claim still within its limitation period", () => {
    const flightDateUtc = new Date(Date.UTC(2020, 0, 1));
    const now = new Date(Date.UTC(2022, 0, 1));
    expect(isPastLimitationDeadline({ countryCode: "DE", flightDateUtc }, now)).toBe(false);
  });

  it("throws for an unconfigured jurisdiction, never silently skipping the check", () => {
    const flightDateUtc = new Date(Date.UTC(2024, 0, 1));
    expect(() => getLimitationDeadlineUtc({ countryCode: "ZZ", flightDateUtc })).toThrow(
      UnknownJurisdictionError,
    );
  });

  it("is stable across a DST boundary (UTC arithmetic, not local time)", () => {
    // Crossing a DST change (e.g. an EU spring-forward date) must not shift the day.
    const flightDateUtc = new Date(Date.UTC(2023, 2, 26)); // 2023-03-26 (EU DST start)
    const deadline = getLimitationDeadlineUtc({ countryCode: "DE", flightDateUtc });
    expect(deadline.getUTCFullYear()).toBe(2026);
    expect(deadline.getUTCMonth()).toBe(2);
    expect(deadline.getUTCDate()).toBe(26);
  });
});

describe("airline response timeout", () => {
  it("computes the deadline as sentAt + timeoutDays", () => {
    const sentAtUtc = new Date(Date.UTC(2024, 0, 1));
    const deadline = getAirlineResponseDeadlineUtc(sentAtUtc, 14);
    expect(deadline.toISOString()).toBe(new Date(Date.UTC(2024, 0, 15)).toISOString());
  });

  it("has not timed out before the deadline", () => {
    const sentAtUtc = new Date(Date.UTC(2024, 0, 1));
    const now = new Date(Date.UTC(2024, 0, 14, 23, 59, 59));
    expect(hasAirlineTimedOut(sentAtUtc, 14, now)).toBe(false);
  });

  it("has timed out exactly at the deadline", () => {
    const sentAtUtc = new Date(Date.UTC(2024, 0, 1));
    const now = new Date(Date.UTC(2024, 0, 15));
    expect(hasAirlineTimedOut(sentAtUtc, 14, now)).toBe(true);
  });

  it("has timed out after the deadline", () => {
    const sentAtUtc = new Date(Date.UTC(2024, 0, 1));
    const now = new Date(Date.UTC(2024, 0, 20));
    expect(hasAirlineTimedOut(sentAtUtc, 14, now)).toBe(true);
  });
});

describe("clock discipline", () => {
  it("never calls Date.now() inside domain deadline code", () => {
    const path = fileURLToPath(new URL("../../../../src/domain/claim/deadlines.ts", import.meta.url));
    const source = readFileSync(path, "utf-8");
    expect(source).not.toContain("Date.now()");
  });
});

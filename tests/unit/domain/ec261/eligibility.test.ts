import { describe, it, expect } from "vitest";
import {
  checkEligibility,
  InvalidEligibilityInputError,
  type EligibilityInput,
} from "../../../../src/domain/ec261/eligibility.js";

const EU_TO_EU: EligibilityInput = {
  disruptionType: "delay",
  departureCountryIsEU: true,
  arrivalCountryIsEU: true,
  operatingCarrierIsEU: true,
};

describe("checkEligibility — delay", () => {
  it("is not eligible at 2h59m", () => {
    const result = checkEligibility({ ...EU_TO_EU, delayMinutesAtArrival: 179 });
    expect(result.eligible).toBe(false);
  });

  it("is eligible at exactly 3h00m", () => {
    const result = checkEligibility({ ...EU_TO_EU, delayMinutesAtArrival: 180 });
    expect(result.eligible).toBe(true);
  });

  it("is eligible at 3h01m", () => {
    const result = checkEligibility({ ...EU_TO_EU, delayMinutesAtArrival: 181 });
    expect(result.eligible).toBe(true);
  });

  it("measures delay on arrival, not departure — the input has no departure-delay field at all", () => {
    // A flight that departed 5 hours late but arrived only 10 minutes late must not
    // be eligible. Because EligibilityInput only accepts delayMinutesAtArrival, the
    // type itself prevents accidentally scoring on departure delay.
    const result = checkEligibility({ ...EU_TO_EU, delayMinutesAtArrival: 10 });
    expect(result.eligible).toBe(false);
  });

  it("throws if delayMinutesAtArrival is missing for a delay claim", () => {
    const { delayMinutesAtArrival: _omit, ...rest } = { ...EU_TO_EU, delayMinutesAtArrival: 200 };
    expect(() => checkEligibility(rest as EligibilityInput)).toThrow(
      InvalidEligibilityInputError,
    );
  });
});

describe("checkEligibility — connecting itineraries (Folkerts v Air France, C-11/11)", () => {
  it("is not eligible when an early-leg delay is absorbed before the final arrival", () => {
    // The caller is responsible for combining segments — this documents the
    // contract: delayMinutesAtArrival must be the FINAL arrival delay, not any
    // intermediate leg's own delay. A 4h delay on leg 1 that still gets the
    // passenger to the final destination on schedule must be passed in as 0
    // (or whatever the real final-arrival delta is), never as 240.
    const result = checkEligibility({ ...EU_TO_EU, delayMinutesAtArrival: 0 });
    expect(result.eligible).toBe(false);
  });

  it("is eligible for the WHOLE itinerary when an early-leg delay causes the final arrival to be 3+ hours late", () => {
    // Same scenario, but the leg-1 delay caused a missed connection: the final
    // destination arrival ends up 4 hours late. This is eligible for the full
    // original-departure-to-final-destination trip — there is no concept of
    // "only the delayed leg" in EC261 for a single-booking connection.
    const result = checkEligibility({ ...EU_TO_EU, delayMinutesAtArrival: 240 });
    expect(result.eligible).toBe(true);
  });
});

describe("checkEligibility — route coverage", () => {
  it("covers departure from an EU airport regardless of carrier", () => {
    const result = checkEligibility({
      disruptionType: "delay",
      delayMinutesAtArrival: 200,
      departureCountryIsEU: true,
      arrivalCountryIsEU: false,
      operatingCarrierIsEU: false,
    });
    expect(result.eligible).toBe(true);
  });

  it("does NOT cover arrival into the EU on a non-EU carrier", () => {
    const result = checkEligibility({
      disruptionType: "delay",
      delayMinutesAtArrival: 200,
      departureCountryIsEU: false,
      arrivalCountryIsEU: true,
      operatingCarrierIsEU: false,
    });
    expect(result.eligible).toBe(false);
  });

  it("covers arrival into the EU on an EU carrier", () => {
    const result = checkEligibility({
      disruptionType: "delay",
      delayMinutesAtArrival: 200,
      departureCountryIsEU: false,
      arrivalCountryIsEU: true,
      operatingCarrierIsEU: true,
    });
    expect(result.eligible).toBe(true);
  });

  it("does not cover non-EU to non-EU routes", () => {
    const result = checkEligibility({
      disruptionType: "delay",
      delayMinutesAtArrival: 200,
      departureCountryIsEU: false,
      arrivalCountryIsEU: false,
      operatingCarrierIsEU: true,
    });
    expect(result.eligible).toBe(false);
  });
});

describe("checkEligibility — cancellation", () => {
  it("is not eligible with sufficient notice (>= 14 days)", () => {
    const result = checkEligibility({
      ...EU_TO_EU,
      disruptionType: "cancellation",
      cancellationNoticeDays: 14,
    });
    expect(result.eligible).toBe(false);
  });

  it("is eligible with insufficient notice (< 14 days)", () => {
    const result = checkEligibility({
      ...EU_TO_EU,
      disruptionType: "cancellation",
      cancellationNoticeDays: 13,
    });
    expect(result.eligible).toBe(true);
  });

  it("throws if cancellationNoticeDays is missing for a cancellation claim", () => {
    expect(() =>
      checkEligibility({ ...EU_TO_EU, disruptionType: "cancellation" }),
    ).toThrow(InvalidEligibilityInputError);
  });
});

describe("checkEligibility — denied boarding", () => {
  it("is eligible on a covered route", () => {
    const result = checkEligibility({ ...EU_TO_EU, disruptionType: "denied_boarding" });
    expect(result.eligible).toBe(true);
  });

  it("is not eligible if the route itself is not covered", () => {
    const result = checkEligibility({
      disruptionType: "denied_boarding",
      departureCountryIsEU: false,
      arrivalCountryIsEU: false,
      operatingCarrierIsEU: false,
    });
    expect(result.eligible).toBe(false);
  });
});

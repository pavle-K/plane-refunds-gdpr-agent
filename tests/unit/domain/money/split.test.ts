import { describe, it, expect } from "vitest";
import {
  splitPayout,
  UnsupportedCurrencyError,
  InvalidAmountError,
  InvalidCommissionRateError,
} from "../../../../src/domain/money/split.js";

describe("splitPayout", () => {
  it("splits each compensation band correctly at a 25% commission rate", () => {
    expect(splitPayout({ receivedAmountCents: 25000, currency: "EUR", commissionRateBasisPoints: 2500 })).toEqual({
      receivedAmountCents: 25000,
      commissionCents: 6250,
      payoutCents: 18750,
    });
    expect(splitPayout({ receivedAmountCents: 40000, currency: "EUR", commissionRateBasisPoints: 2500 })).toEqual({
      receivedAmountCents: 40000,
      commissionCents: 10000,
      payoutCents: 30000,
    });
    expect(splitPayout({ receivedAmountCents: 60000, currency: "EUR", commissionRateBasisPoints: 2500 })).toEqual({
      receivedAmountCents: 60000,
      commissionCents: 15000,
      payoutCents: 45000,
    });
  });

  it("always sums commission + payout to exactly the received amount, no lost or invented cents", () => {
    const rates = [0, 1, 2500, 3333, 5000, 9999, 10000];
    const amounts = [1, 3, 7, 25000, 40001, 60007, 999999];
    for (const commissionRateBasisPoints of rates) {
      for (const receivedAmountCents of amounts) {
        const result = splitPayout({ receivedAmountCents, currency: "EUR", commissionRateBasisPoints });
        expect(result.commissionCents + result.payoutCents).toBe(receivedAmountCents);
        expect(Number.isInteger(result.commissionCents)).toBe(true);
        expect(Number.isInteger(result.payoutCents)).toBe(true);
      }
    }
  });

  it("handles a zero airline payment explicitly", () => {
    expect(splitPayout({ receivedAmountCents: 0, currency: "EUR", commissionRateBasisPoints: 2500 })).toEqual({
      receivedAmountCents: 0,
      commissionCents: 0,
      payoutCents: 0,
    });
  });

  it("handles a partial airline payment (less than the full owed compensation)", () => {
    // The airline only paid part of what was owed — split whatever actually arrived.
    const result = splitPayout({ receivedAmountCents: 10000, currency: "EUR", commissionRateBasisPoints: 2500 });
    expect(result.commissionCents).toBe(2500);
    expect(result.payoutCents).toBe(7500);
  });

  it("throws on a non-EUR currency instead of silently converting", () => {
    expect(() =>
      splitPayout({ receivedAmountCents: 25000, currency: "USD", commissionRateBasisPoints: 2500 }),
    ).toThrow(UnsupportedCurrencyError);
  });

  it("throws on a negative or non-integer amount", () => {
    expect(() =>
      splitPayout({ receivedAmountCents: -1, currency: "EUR", commissionRateBasisPoints: 2500 }),
    ).toThrow(InvalidAmountError);
    expect(() =>
      splitPayout({ receivedAmountCents: 100.5, currency: "EUR", commissionRateBasisPoints: 2500 }),
    ).toThrow(InvalidAmountError);
  });

  it("throws on an out-of-range or non-integer commission rate", () => {
    expect(() =>
      splitPayout({ receivedAmountCents: 25000, currency: "EUR", commissionRateBasisPoints: -1 }),
    ).toThrow(InvalidCommissionRateError);
    expect(() =>
      splitPayout({ receivedAmountCents: 25000, currency: "EUR", commissionRateBasisPoints: 10001 }),
    ).toThrow(InvalidCommissionRateError);
  });
});

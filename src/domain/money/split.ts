const SUPPORTED_CURRENCY = "EUR";

export interface SplitInput {
  receivedAmountCents: number;
  currency: string;
  /** Commission rate in basis points (e.g. 2500 = 25%). */
  commissionRateBasisPoints: number;
}

export interface SplitResult {
  receivedAmountCents: number;
  commissionCents: number;
  payoutCents: number;
}

export class UnsupportedCurrencyError extends Error {
  constructor(currency: string) {
    super(`Unsupported currency: ${currency}. Only ${SUPPORTED_CURRENCY} is supported — no automatic conversion.`);
    this.name = "UnsupportedCurrencyError";
  }
}

export class InvalidAmountError extends Error {
  constructor(receivedAmountCents: number) {
    super(`receivedAmountCents must be a non-negative integer, got ${receivedAmountCents}`);
    this.name = "InvalidAmountError";
  }
}

export class InvalidCommissionRateError extends Error {
  constructor(commissionRateBasisPoints: number) {
    super(
      `commissionRateBasisPoints must be an integer between 0 and 10000, got ${commissionRateBasisPoints}`,
    );
    this.name = "InvalidCommissionRateError";
  }
}

/**
 * Splits a received payment into commission + payout. commissionCents is always
 * rounded DOWN to the nearest cent, so commissionCents + payoutCents === received
 * exactly — the passenger never loses a cent to rounding, and no cent is invented.
 */
export function splitPayout(input: SplitInput): SplitResult {
  if (input.currency.toUpperCase() !== SUPPORTED_CURRENCY) {
    throw new UnsupportedCurrencyError(input.currency);
  }
  if (!Number.isInteger(input.receivedAmountCents) || input.receivedAmountCents < 0) {
    throw new InvalidAmountError(input.receivedAmountCents);
  }
  if (
    !Number.isInteger(input.commissionRateBasisPoints) ||
    input.commissionRateBasisPoints < 0 ||
    input.commissionRateBasisPoints > 10000
  ) {
    throw new InvalidCommissionRateError(input.commissionRateBasisPoints);
  }

  if (input.receivedAmountCents === 0) {
    return { receivedAmountCents: 0, commissionCents: 0, payoutCents: 0 };
  }

  const commissionCents = Math.floor(
    (input.receivedAmountCents * input.commissionRateBasisPoints) / 10000,
  );
  const payoutCents = input.receivedAmountCents - commissionCents;

  return { receivedAmountCents: input.receivedAmountCents, commissionCents, payoutCents };
}

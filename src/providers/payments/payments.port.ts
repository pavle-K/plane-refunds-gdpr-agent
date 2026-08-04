import type { Result } from "../../lib/result.js";

export interface PayoutRequest {
  claimId: string;
  /** Stripe Connect account id for the passenger being paid out. */
  connectedAccountId: string;
  payoutCents: number;
  currency: string;
}

export interface PayoutReceipt {
  transferId: string;
  processedAtUtc: string;
}

export type PaymentsError =
  | { type: "invalid_account"; message: string }
  | { type: "insufficient_funds"; message: string }
  | { type: "upstream_error"; message: string };

export interface PaymentsProvider {
  transferPayout(request: PayoutRequest): Promise<Result<PayoutReceipt, PaymentsError>>;
}

import { ok, type Result } from "../../lib/result.js";
import type { PaymentsProvider, PayoutRequest, PayoutReceipt, PaymentsError } from "./payments.port.js";

/** Records transfers instead of moving money. Never touches Stripe. */
export class FakePaymentsAdapter implements PaymentsProvider {
  readonly transfers: PayoutRequest[] = [];
  private nextResult: Result<PayoutReceipt, PaymentsError> | null = null;
  private transferCounter = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  queueResult(result: Result<PayoutReceipt, PaymentsError>): void {
    this.nextResult = result;
  }

  async transferPayout(request: PayoutRequest): Promise<Result<PayoutReceipt, PaymentsError>> {
    this.transfers.push(request);

    if (this.nextResult) {
      const result = this.nextResult;
      this.nextResult = null;
      return result;
    }

    this.transferCounter += 1;
    return ok({
      transferId: `fake-transfer-${this.transferCounter}`,
      processedAtUtc: this.clock().toISOString(),
    });
  }
}

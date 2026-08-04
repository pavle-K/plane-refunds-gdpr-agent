import { describe, it, expect } from "vitest";
import { FakePaymentsAdapter } from "../../../../src/providers/payments/fake.adapter.js";
import { err } from "../../../../src/lib/result.js";

const REQUEST = { claimId: "claim-1", connectedAccountId: "acct_123", payoutCents: 18750, currency: "EUR" };

describe("FakePaymentsAdapter", () => {
  it("records the transfer instead of moving money", async () => {
    const adapter = new FakePaymentsAdapter();
    await adapter.transferPayout(REQUEST);
    expect(adapter.transfers).toEqual([REQUEST]);
  });

  it("returns a successful receipt with an incrementing transfer id", async () => {
    const adapter = new FakePaymentsAdapter();
    const first = await adapter.transferPayout(REQUEST);
    const second = await adapter.transferPayout(REQUEST);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.transferId).not.toBe(second.value.transferId);
    }
  });

  it("can be queued to simulate a failed transfer", async () => {
    const adapter = new FakePaymentsAdapter();
    adapter.queueResult(err({ type: "invalid_account", message: "no such connected account" }));

    const result = await adapter.transferPayout(REQUEST);
    expect(result).toEqual(err({ type: "invalid_account", message: "no such connected account" }));
  });
});

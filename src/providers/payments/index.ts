import type { PaymentsProvider } from "./payments.port.js";
import { FakePaymentsAdapter } from "./fake.adapter.js";

export * from "./payments.port.js";
export { FakePaymentsAdapter } from "./fake.adapter.js";

/**
 * No real Stripe Connect adapter — CLAUDE.md §6 explicitly puts entity
 * registration, tax treatment, and Stripe Connect legal setup out of scope for
 * this plan ("business/legal steps, not engineering ones... before real client
 * funds move through the system"). Build the real adapter once that's done.
 */
export function createPaymentsProvider(): PaymentsProvider {
  return new FakePaymentsAdapter();
}

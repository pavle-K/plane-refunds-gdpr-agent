import { centsToEuros } from "../../lib/money.js";
import type { PayoutOutcome } from "../../api/types.js";

/** compensationCents is a pure distance-band calculation (src/domain/ec261/
 * compensation.ts) computed independently of eligibility — it's never null
 * just because a claim turned out ineligible. Showing that figure as if it
 * were owed money on an ineligible claim is actively misleading, so
 * eligible === false is checked FIRST, before compensationCents at all. */
export function MoneySummary({
  compensationCents,
  payout,
  eligible,
}: {
  compensationCents: number | null;
  payout: PayoutOutcome | null;
  eligible: boolean | null;
}) {
  if (eligible === false) {
    return <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Not eligible — no compensation owed.</p>;
  }
  if (payout) {
    return (
      <div>
        <p style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--success)", margin: 0 }}>{centsToEuros(payout.payoutCents)}</p>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", margin: "0.2rem 0 0" }}>
          Paid out — {centsToEuros(payout.commissionCents)} commission deducted from the airline's payment.
        </p>
      </div>
    );
  }
  if (compensationCents !== null) {
    return (
      <div>
        <p style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>{centsToEuros(compensationCents)}</p>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", margin: "0.2rem 0 0" }}>Estimated compensation, before commission.</p>
      </div>
    );
  }
  return <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Compensation not yet calculated.</p>;
}

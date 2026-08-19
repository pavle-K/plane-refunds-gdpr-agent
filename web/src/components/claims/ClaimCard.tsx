import { Link } from "react-router-dom";
import type { ClaimSummary } from "../../api/types.js";
import { CLAIM_STATUS_META, effectiveDisplayStatus } from "../../lib/claimStatusMeta.js";
import { centsToEuros } from "../../lib/money.js";
import { formatDate } from "../../lib/dates.js";

export function ClaimCard({ claim }: { claim: ClaimSummary }) {
  const segment = claim.booking?.segments[0];
  const title = segment ? `${segment.operatingCarrierCode} ${segment.flightNumber}` : claim.bookingReference;
  // Falls back rather than crashing the whole list on one unexpected/missing
  // status — see StatusTimeline's identical guard for why this is real, not
  // theoretical.
  const meta = CLAIM_STATUS_META[effectiveDisplayStatus(claim)] ?? {
    label: String(claim.claimStatus),
    color: "var(--text-secondary)",
  };
  // compensationCents is computed independently of eligibility (a pure
  // distance calc) — never show it as if it's owed money on a claim that
  // turned out ineligible. See MoneySummary's identical guard.
  const amountCents = claim.payout?.payoutCents ?? (claim.eligible === false ? null : claim.compensationCents);

  return (
    <Link
      to={`/claims/${claim.threadId}`}
      style={{
        display: "block",
        padding: "0.9rem 1rem",
        borderRadius: "0.6rem",
        border: "1px solid var(--border)",
        marginBottom: "0.6rem",
        textDecoration: "none",
        color: "var(--text)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{title}</strong>
        <span style={{ color: meta.color, fontSize: "0.8rem", fontWeight: 600 }}>{meta.label}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.3rem", color: "var(--text-secondary)", fontSize: "0.8rem" }}>
        <span>{segment ? formatDate(segment.scheduledDepartureUtc) : "—"}</span>
        <span>{amountCents !== null ? centsToEuros(amountCents) : "—"}</span>
      </div>
    </Link>
  );
}

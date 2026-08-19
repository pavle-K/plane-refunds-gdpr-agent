import type { CSSProperties } from "react";
import { useClaim } from "../../api/useClaims.js";
import { ClaimTabs } from "./ClaimTabs.js";
import { formatDate } from "../../lib/dates.js";

const panelStyle: CSSProperties = {
  width: "24rem",
  flexShrink: 0,
  borderLeft: "1px solid var(--border)",
  padding: "1rem",
  overflowY: "auto",
};

/** The claim-detail counterpart to the chat: always visible alongside it
 * rather than buried in scrollback. Reuses the exact same GET
 * /api/web/claims/:id read the chat's get_claim_status tool call uses. */
export function ClaimSidePanel({ claimId }: { claimId: string | undefined }) {
  const { data, isLoading, error } = useClaim(claimId);

  if (!claimId) {
    return (
      <aside style={panelStyle}>
        <p style={{ color: "var(--text-secondary)" }}>No claim yet — mention a flight in the chat to start one.</p>
      </aside>
    );
  }
  if (isLoading) {
    return (
      <aside style={panelStyle}>
        <p style={{ color: "var(--text-secondary)" }}>Loading claim…</p>
      </aside>
    );
  }
  if (error || !data) {
    return (
      <aside style={panelStyle}>
        <p role="alert" style={{ color: "var(--danger)" }}>
          Couldn't load this claim.
        </p>
      </aside>
    );
  }

  const segment = data.booking?.segments[0];
  const title = segment ? `${segment.operatingCarrierCode} ${segment.flightNumber}` : (data.booking?.bookingReference ?? "Claim");

  return (
    <aside style={panelStyle}>
      <h2 style={{ fontSize: "1.05rem", margin: 0 }}>{title}</h2>
      {segment && <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", margin: "0.2rem 0 0" }}>{formatDate(segment.scheduledDepartureUtc)}</p>}
      <div style={{ marginTop: "0.9rem" }}>
        <ClaimTabs claim={data} />
      </div>
    </aside>
  );
}

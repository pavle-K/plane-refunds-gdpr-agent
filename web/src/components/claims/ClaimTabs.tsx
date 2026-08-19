import { useState } from "react";
import type { ClaimDetail } from "../../api/types.js";
import { useProfile } from "../../api/useProfile.js";
import { effectiveDisplayStatus } from "../../lib/claimStatusMeta.js";
import { StatusTimeline } from "./StatusTimeline.js";
import { MoneySummary } from "./MoneySummary.js";
import { SubmissionChannelCard } from "./SubmissionChannelCard.js";
import { PostalPackButton } from "./PostalPackButton.js";
import { DraftReviewPanel } from "./DraftReviewPanel.js";
import { DataChecklist } from "./DataChecklist.js";

const TABS = ["Eligibility", "Steps", "Money", "Airline", "Data"] as const;
type Tab = (typeof TABS)[number];

export function ClaimTabs({ claim }: { claim: ClaimDetail }) {
  const [active, setActive] = useState<Tab>("Steps");
  const profile = useProfile();

  return (
    <div>
      <div style={{ display: "flex", gap: "0.25rem", borderBottom: "1px solid var(--border)", marginBottom: "0.9rem" }}>
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActive(tab)}
            style={{
              padding: "0.45rem 0.7rem",
              border: "none",
              background: "transparent",
              color: active === tab ? "var(--accent)" : "var(--text-secondary)",
              borderBottom: active === tab ? "2px solid var(--accent)" : "2px solid transparent",
              fontWeight: active === tab ? 600 : 500,
              fontSize: "0.8rem",
              cursor: "pointer",
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {active === "Eligibility" && (
        <div>
          {claim.eligible === null ? (
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>Not checked yet.</p>
          ) : (
            <>
              <p style={{ fontWeight: 600, color: claim.eligible ? "var(--success)" : "var(--danger)", margin: 0 }}>
                {claim.eligible ? "Eligible" : "Not eligible"}
              </p>
              {claim.eligibilityReason && (
                <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "0.4rem" }}>{claim.eligibilityReason}</p>
              )}
            </>
          )}
        </div>
      )}

      {active === "Steps" && (
        <div>
          <StatusTimeline status={effectiveDisplayStatus(claim)} />
          {/* awaitingInput + pausedOn, not claimStatus — see effectiveDisplayStatus's
           * doc comment for why claimStatus alone can't detect this. Covers both an
           * original draft AND a rebuttal draft waiting for a decision — both pause
           * at the same "humanApproval" node. */}
          {claim.awaitingInput && claim.pausedOn === "humanApproval" && claim.draftText && (
            <DraftReviewPanel
              claimId={claim.threadId}
              draftText={claim.draftText}
              canAutoSend={Boolean(claim.submission?.autoSendChannel)}
            />
          )}
          {claim.escalationReason && (
            <p style={{ color: "var(--danger)", fontSize: "0.85rem", marginTop: "0.6rem" }}>{claim.escalationReason}</p>
          )}
        </div>
      )}

      {active === "Money" && (
        <MoneySummary compensationCents={claim.compensationCents} payout={claim.payout} eligible={claim.eligible} />
      )}

      {active === "Airline" && (
        <div>
          {!claim.submission || claim.submission.channels.length === 0 ? (
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>No airline contact on record yet.</p>
          ) : (
            <>
              {claim.submission.carrierName && <p style={{ fontWeight: 600, margin: "0 0 0.5rem" }}>{claim.submission.carrierName}</p>}
              {claim.submission.channels.map((channel) => (
                <SubmissionChannelCard key={channel.id} channel={channel} />
              ))}
              {claim.submission.channels.some((c) => c.kind === "postal") && <PostalPackButton claimId={claim.threadId} />}
            </>
          )}
        </div>
      )}

      {active === "Data" && <DataChecklist profile={profile.data} booking={claim.booking} />}
    </div>
  );
}

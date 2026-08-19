import type { ClaimStatus } from "../../api/types.js";
import { CLAIM_STATUS_META, HAPPY_PATH_STATUSES, OFF_PATH_BRANCH_POINT } from "../../lib/claimStatusMeta.js";

export function StatusTimeline({ status }: { status: ClaimStatus }) {
  const meta = CLAIM_STATUS_META[status];
  // Defensive, not just theoretical: a claim whose backend state read comes
  // back missing/unexpected (e.g. an interrupted graph invocation whose
  // checkpoint never landed where a later read expects it — see the
  // nested-graph-namespace fix this shipped alongside) previously crashed
  // this whole page rather than showing a plain "unknown" state, because
  // every field below assumed `meta` always exists.
  if (!meta) {
    return <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>Status unavailable ({String(status)}).</p>;
  }
  const happyIndex = HAPPY_PATH_STATUSES.indexOf(status);
  const isOnHappyPath = happyIndex !== -1;
  const completedThrough = isOnHappyPath ? happyIndex : (OFF_PATH_BRANCH_POINT[status] ?? 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center" }}>
        {HAPPY_PATH_STATUSES.map((step, index) => {
          const isDone = index <= completedThrough;
          const isCurrent = isOnHappyPath && index === happyIndex;
          const isLast = index === HAPPY_PATH_STATUSES.length - 1;
          return (
            <div key={step} style={{ display: "flex", alignItems: "center", flex: isLast ? "0 0 auto" : 1 }}>
              <div
                title={CLAIM_STATUS_META[step].label}
                style={{
                  width: "0.7rem",
                  height: "0.7rem",
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: isDone ? (isCurrent ? CLAIM_STATUS_META[step].color : "var(--text-secondary)") : "var(--border)",
                }}
              />
              {!isLast && (
                <div style={{ flex: 1, height: 2, background: index < completedThrough ? "var(--text-secondary)" : "var(--border)" }} />
              )}
            </div>
          );
        })}
      </div>
      <p style={{ marginTop: "0.5rem", marginBottom: "0.15rem", fontWeight: 600, color: meta.color }}>{meta.label}</p>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>{meta.description}</p>
    </div>
  );
}

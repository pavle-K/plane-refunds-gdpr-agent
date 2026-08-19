import type { PresentableChannel } from "../../api/types.js";

const VERIFICATION_LABEL: Record<PresentableChannel["verification"], string> = {
  verified: "Verified",
  partially_verified: "Partially verified",
  unverified: "Unverified",
};

export function SubmissionChannelCard({ channel }: { channel: PresentableChannel }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "0.6rem",
        padding: "0.75rem",
        marginBottom: "0.6rem",
        fontSize: "0.85rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong style={{ textTransform: "capitalize" }}>{channel.label}</strong>
        <span style={{ color: "var(--text-secondary)", fontSize: "0.75rem" }}>{VERIFICATION_LABEL[channel.verification]}</span>
      </div>
      {channel.url && (
        <p style={{ margin: "0.4rem 0 0", wordBreak: "break-all" }}>
          <a href={channel.url} target="_blank" rel="noreferrer">
            {channel.url}
          </a>
        </p>
      )}
      {channel.emailAddress && <p style={{ margin: "0.4rem 0 0" }}>{channel.emailAddress}</p>}
      {channel.postalAddress && (
        <p style={{ margin: "0.4rem 0 0", whiteSpace: "pre-line" }}>{channel.postalAddress.join("\n")}</p>
      )}
      {channel.requiredFieldLabels && channel.requiredFieldLabels.length > 0 && (
        <p style={{ margin: "0.4rem 0 0", color: "var(--text-secondary)" }}>You'll need: {channel.requiredFieldLabels.join(", ")}.</p>
      )}
      {channel.guidance.map((line, i) => (
        <p key={i} style={{ margin: "0.4rem 0 0", color: "var(--text-secondary)" }}>
          {line}
        </p>
      ))}
    </div>
  );
}

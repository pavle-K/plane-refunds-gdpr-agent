const PROVIDER_LABEL: Record<"gmail" | "outlook", string> = { gmail: "Gmail", outlook: "Outlook" };

export function OauthConnectBubble({
  provider,
  authorizationUrl,
  blocked,
}: {
  provider: "gmail" | "outlook";
  authorizationUrl: string;
  blocked: boolean;
}) {
  return (
    <div
      style={{
        maxWidth: "34rem",
        padding: "0.75rem 0.9rem",
        borderRadius: "0.8rem",
        border: "1px solid var(--border)",
        background: "var(--bg-inset)",
        fontSize: "0.9rem",
      }}
    >
      {blocked ? (
        <>
          <p style={{ margin: "0 0 0.5rem" }}>
            Your browser blocked the connection popup. Open it manually to finish connecting {PROVIDER_LABEL[provider]}:
          </p>
          <a href={authorizationUrl} target="_blank" rel="noreferrer">
            Connect {PROVIDER_LABEL[provider]}
          </a>
        </>
      ) : (
        <p style={{ margin: 0, color: "var(--text-secondary)" }}>
          A window opened to connect {PROVIDER_LABEL[provider]} — finish signing in there. This will update
          automatically once it's done.
        </p>
      )}
    </div>
  );
}

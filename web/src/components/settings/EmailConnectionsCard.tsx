import { useEmailConnections } from "../../api/useEmailConnections.js";
import { useSendMessage } from "../../api/useChat.js";
import { openOauthPopup } from "../oauth/openOauthPopup.js";

const rowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.5rem 0", borderBottom: "1px solid var(--border)" };

/** Drives connect_email through the same chat tool-call path the operator
 * conversation already uses (see useSendMessage), rather than a separate
 * non-chat "connect" endpoint — this is the one place that already knows how
 * to mint a real OAuth authorization URL and route the popup's confirmation
 * back to the right identity. */
export function EmailConnectionsCard() {
  const connections = useEmailConnections();
  const sendMessage = useSendMessage();

  function connect(provider: "gmail" | "outlook") {
    sendMessage.mutate(`connect my ${provider} account`, {
      onSuccess: (response) => {
        const action = response.actions.find((a) => a.type === "oauth_popup" && a.provider === provider);
        if (action) {
          openOauthPopup(action.authorizationUrl);
        }
      },
    });
  }

  if (connections.isLoading) {
    return <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Loading…</p>;
  }

  return (
    <div>
      {(["gmail", "outlook"] as const).map((provider) => {
        const status = connections.data?.[provider];
        return (
          <div key={provider} style={rowStyle}>
            <div>
              <div style={{ textTransform: "capitalize", fontWeight: 600, fontSize: "0.9rem" }}>{provider}</div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
                {status?.connected ? status.emailAddress : "Not connected"}
              </div>
            </div>
            {!status?.connected && (
              <button
                type="button"
                onClick={() => connect(provider)}
                disabled={sendMessage.isPending}
                style={{
                  padding: "0.4rem 0.8rem",
                  borderRadius: "0.5rem",
                  border: "1px solid var(--border)",
                  background: "var(--bg-inset)",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
              >
                Connect
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

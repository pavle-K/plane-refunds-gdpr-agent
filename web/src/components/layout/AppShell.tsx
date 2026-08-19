import { TopNav } from "./TopNav.js";
import { ChatPanel } from "../chat/ChatPanel.js";
import { ClaimSidePanel } from "../claims/ClaimSidePanel.js";

/** Persistent two-pane layout: chat on the left, the in-focus claim's status
 * panel on the right — always visible together, rather than the claim's
 * status/airline contact/money owed being buried somewhere in chat
 * scrollback. */
export function AppShell({ claimId }: { claimId?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopNav />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, padding: "1rem" }}>
          <ChatPanel />
        </div>
        <ClaimSidePanel claimId={claimId} />
      </div>
    </div>
  );
}

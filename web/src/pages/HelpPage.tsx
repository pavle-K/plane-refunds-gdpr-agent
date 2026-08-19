import { TopNav } from "../components/layout/TopNav.js";
import { HelpPanel } from "../components/help/HelpPanel.js";

export function HelpPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopNav />
      <div style={{ flex: 1, minHeight: 0, maxWidth: "34rem", width: "100%", margin: "0 auto", padding: "1.5rem", overflowY: "auto" }}>
        <h1 style={{ fontSize: "1.3rem" }}>How this works</h1>
        <HelpPanel />
      </div>
    </div>
  );
}

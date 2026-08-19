import { TopNav } from "../components/layout/TopNav.js";
import { ThemeToggle } from "../components/settings/ThemeToggle.js";
import { ProfileForm } from "../components/settings/ProfileForm.js";
import { EmailConnectionsCard } from "../components/settings/EmailConnectionsCard.js";
import { DangerZoneModal } from "../components/settings/DangerZoneModal.js";

const sectionStyle = { marginBottom: "2rem" };
const headingStyle = { fontSize: "1rem", margin: "0 0 0.8rem" };

export function SettingsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopNav />
      <div style={{ flex: 1, minHeight: 0, maxWidth: "34rem", width: "100%", margin: "0 auto", padding: "1.5rem", overflowY: "auto" }}>
        <h1 style={{ fontSize: "1.3rem" }}>Settings</h1>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Appearance</h2>
          <ThemeToggle />
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Your details</h2>
          <ProfileForm />
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Connected inboxes</h2>
          <EmailConnectionsCard />
        </section>

        <section style={sectionStyle}>
          <h2 style={{ ...headingStyle, color: "var(--danger)" }}>Danger zone</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: 0 }}>
            Permanently deletes your saved details, chat history, and any claim never sent to an airline.
          </p>
          <DangerZoneModal />
        </section>
      </div>
    </div>
  );
}

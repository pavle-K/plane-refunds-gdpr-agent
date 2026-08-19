import { NavLink } from "react-router-dom";

const linkStyle = ({ isActive }: { isActive: boolean }) => ({
  color: isActive ? "var(--accent)" : "var(--text-secondary)",
  fontWeight: isActive ? 600 : 500,
  fontSize: "0.88rem",
  textDecoration: "none",
});

export function TopNav() {
  return (
    <nav
      style={{
        display: "flex",
        gap: "1.25rem",
        alignItems: "center",
        padding: "0.75rem 1.25rem",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <strong style={{ marginRight: "0.5rem" }}>EC261 Claim Assistant</strong>
      <NavLink to="/" end style={linkStyle}>
        Chat
      </NavLink>
      <NavLink to="/claims" style={linkStyle}>
        Claims
      </NavLink>
      <NavLink to="/help" style={linkStyle}>
        Help
      </NavLink>
      <NavLink to="/settings" style={linkStyle}>
        Settings
      </NavLink>
    </nav>
  );
}

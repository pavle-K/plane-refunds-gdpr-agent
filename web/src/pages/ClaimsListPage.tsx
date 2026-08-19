import { Link } from "react-router-dom";
import { TopNav } from "../components/layout/TopNav.js";
import { ClaimCard } from "../components/claims/ClaimCard.js";
import { useClaims } from "../api/useClaims.js";

export function ClaimsListPage() {
  const claims = useClaims();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopNav />
      <div style={{ flex: 1, minHeight: 0, maxWidth: "40rem", width: "100%", margin: "0 auto", padding: "1.5rem", overflowY: "auto" }}>
        <h1 style={{ fontSize: "1.3rem" }}>Your claims</h1>

        {claims.isLoading && <p style={{ color: "var(--text-secondary)" }}>Loading…</p>}

        {claims.data?.claims.length === 0 && (
          <p style={{ color: "var(--text-secondary)" }}>
            No claims yet — <Link to="/">start one in chat</Link> by describing a delayed or cancelled flight.
          </p>
        )}

        {claims.data?.claims.map((claim) => <ClaimCard key={claim.threadId} claim={claim} />)}
      </div>
    </div>
  );
}

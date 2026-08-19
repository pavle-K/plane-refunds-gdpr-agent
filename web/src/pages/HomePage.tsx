import { useClaims } from "../api/useClaims.js";
import { AppShell } from "../components/layout/AppShell.js";

export function HomePage() {
  const claims = useClaims();
  const mostRecentClaimId = claims.data?.claims[0]?.threadId;
  return <AppShell claimId={mostRecentClaimId} />;
}

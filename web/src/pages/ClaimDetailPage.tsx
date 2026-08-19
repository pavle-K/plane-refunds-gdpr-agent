import { useParams } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell.js";

export function ClaimDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <AppShell claimId={id} />;
}

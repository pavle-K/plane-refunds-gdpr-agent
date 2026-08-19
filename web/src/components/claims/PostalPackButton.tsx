import { useSendPostalPack } from "../../api/useClaims.js";

export function PostalPackButton({ claimId }: { claimId: string }) {
  const sendPostalPack = useSendPostalPack(claimId);
  const result = sendPostalPack.data;

  return (
    <div style={{ marginTop: "0.5rem" }}>
      <button
        type="button"
        onClick={() => sendPostalPack.mutate()}
        disabled={sendPostalPack.isPending}
        style={{
          padding: "0.5rem 0.9rem",
          borderRadius: "0.5rem",
          border: "1px solid var(--border)",
          background: "var(--bg-inset)",
          cursor: sendPostalPack.isPending ? "default" : "pointer",
          fontSize: "0.85rem",
        }}
      >
        {sendPostalPack.isPending ? "Generating…" : "Get a printable postal form"}
      </button>

      {result?.error && (
        <p style={{ color: "var(--danger)", fontSize: "0.8rem", marginTop: "0.4rem" }}>{result.error}</p>
      )}
      {result?.generated && (
        <div style={{ fontSize: "0.8rem", marginTop: "0.4rem", color: "var(--text-secondary)" }}>
          {result.deliveredTo && result.deliveredTo.length > 0 && <p style={{ margin: 0 }}>Sent to: {result.deliveredTo.join(", ")}.</p>}
          {result.failed && result.failed.length > 0 && <p style={{ margin: "0.2rem 0 0" }}>Couldn't deliver via: {result.failed.join(", ")}.</p>}
          {result.outstandingFields && result.outstandingFields.length > 0 && (
            <p style={{ margin: "0.2rem 0 0" }}>Still blank on the form: {result.outstandingFields.join(", ")}.</p>
          )}
        </div>
      )}
    </div>
  );
}

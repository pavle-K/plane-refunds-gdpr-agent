import { useState, type CSSProperties } from "react";
import { useApproveClaim } from "../../api/useClaims.js";

export function DraftReviewPanel({
  claimId,
  draftText,
  canAutoSend,
}: {
  claimId: string;
  draftText: string;
  /** Whether this carrier has an automated send path at all — see
   * SubmissionPlan.autoSendChannel. When false, "Approve" only records your
   * decision; nothing gets dispatched, and the wording below says so before
   * you click, instead of only becoming clear afterward on the Steps tab. */
  canAutoSend: boolean;
}) {
  const approveClaim = useApproveClaim(claimId);
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(draftText);

  if (editing) {
    return (
      <div style={{ marginTop: "0.75rem" }}>
        <textarea
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          rows={10}
          style={{
            width: "100%",
            padding: "0.6rem",
            borderRadius: "0.5rem",
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            fontFamily: "inherit",
            fontSize: "0.85rem",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <button
            type="button"
            onClick={() => approveClaim.mutate({ action: "edit", editedText }, { onSuccess: () => setEditing(false) })}
            disabled={approveClaim.isPending}
            style={buttonStyle("var(--accent)", "var(--accent-contrast)")}
          >
            Save edit
          </button>
          <button type="button" onClick={() => setEditing(false)} style={buttonStyle("var(--bg-inset)", "var(--text)")}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: "0.75rem" }}>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          fontFamily: "inherit",
          fontSize: "0.82rem",
          background: "var(--bg-inset)",
          border: "1px solid var(--border)",
          borderRadius: "0.5rem",
          padding: "0.75rem",
          maxHeight: "16rem",
          overflowY: "auto",
        }}
      >
        {draftText}
      </pre>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", margin: "0.5rem 0 0" }}>
        {canAutoSend
          ? "Approving sends this to the airline automatically."
          : "This airline has no automated channel — approving just confirms the details above are correct. You'll still need to submit it yourself; see the Airline tab for the link and what it needs."}
      </p>
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        <button
          type="button"
          onClick={() => approveClaim.mutate({ action: "approve" })}
          disabled={approveClaim.isPending}
          style={buttonStyle("var(--success)", "#ffffff")}
        >
          {canAutoSend ? "Approve" : "Confirm — I'll submit it myself"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditedText(draftText);
            setEditing(true);
          }}
          disabled={approveClaim.isPending}
          style={buttonStyle("var(--bg-inset)", "var(--text)")}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => approveClaim.mutate({ action: "decline" })}
          disabled={approveClaim.isPending}
          style={buttonStyle("transparent", "var(--danger)")}
        >
          Decline
        </button>
      </div>
      {approveClaim.isError && <p style={{ color: "var(--danger)", fontSize: "0.8rem", marginTop: "0.4rem" }}>That didn't go through — try again.</p>}
    </div>
  );
}

function buttonStyle(background: string, color: string): CSSProperties {
  return {
    padding: "0.5rem 0.9rem",
    borderRadius: "0.5rem",
    border: background === "transparent" ? "1px solid var(--danger)" : "none",
    background,
    color,
    fontWeight: 600,
    fontSize: "0.85rem",
    cursor: "pointer",
  };
}

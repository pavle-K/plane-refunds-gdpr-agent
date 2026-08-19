import { useState } from "react";
import { useSendMessage } from "../../api/useChat.js";

type Stage = "idle" | "confirming" | "done";

/**
 * Drives forget_my_data through the exact same chat text + deterministic
 * pending_confirmations gate the LLM conversation already uses (see
 * src/operator/session.ts) — this button is a UI shortcut onto that flow,
 * not a second deletion code path. The confirmation text shown here is the
 * real, dynamically-computed confirmationPrompt (what will actually be
 * deleted vs. kept, per this specific account), not static copy — that gate
 * exists precisely so an irreversible action is never triggered by anything
 * other than an explicit "yes" to that exact real prompt.
 */
export function DangerZoneModal() {
  const sendMessage = useSendMessage();
  const [stage, setStage] = useState<Stage>("idle");
  const [confirmationPrompt, setConfirmationPrompt] = useState("");
  const [resultText, setResultText] = useState("");

  function start() {
    setStage("confirming");
    sendMessage.mutate("delete all my data", {
      onSuccess: (response) => setConfirmationPrompt(response.reply),
    });
  }

  function respond(affirmative: boolean) {
    sendMessage.mutate(affirmative ? "yes" : "cancel", {
      onSuccess: (response) => {
        setResultText(response.reply);
        setStage(affirmative ? "done" : "idle");
      },
    });
  }

  if (stage === "idle") {
    return (
      <button
        type="button"
        onClick={start}
        style={{
          padding: "0.55rem 1rem",
          borderRadius: "0.5rem",
          border: "1px solid var(--danger)",
          background: "transparent",
          color: "var(--danger)",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Delete all my data
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "0.75rem",
          padding: "1.5rem",
          maxWidth: "28rem",
          width: "90%",
        }}
      >
        <h3 style={{ marginTop: 0, color: "var(--danger)" }}>Delete all my data</h3>

        {stage === "confirming" && (
          <>
            <p style={{ fontSize: "0.9rem", color: "var(--text-secondary)" }}>
              {sendMessage.isPending && !confirmationPrompt ? "Checking what would be deleted…" : confirmationPrompt}
            </p>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
              <button
                type="button"
                onClick={() => respond(true)}
                disabled={!confirmationPrompt || sendMessage.isPending}
                style={{ padding: "0.5rem 0.9rem", borderRadius: "0.5rem", border: "none", background: "var(--danger)", color: "var(--danger-contrast)", fontWeight: 600, cursor: "pointer" }}
              >
                Yes, delete everything
              </button>
              <button
                type="button"
                onClick={() => respond(false)}
                disabled={sendMessage.isPending}
                style={{ padding: "0.5rem 0.9rem", borderRadius: "0.5rem", border: "1px solid var(--border)", background: "var(--bg-inset)", cursor: "pointer" }}
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {stage === "done" && (
          <>
            <p style={{ fontSize: "0.9rem" }}>{resultText}</p>
            <button
              type="button"
              onClick={() => setStage("idle")}
              style={{ padding: "0.5rem 0.9rem", borderRadius: "0.5rem", border: "1px solid var(--border)", background: "var(--bg-inset)", cursor: "pointer" }}
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

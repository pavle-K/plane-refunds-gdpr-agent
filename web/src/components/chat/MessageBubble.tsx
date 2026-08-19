import type { CSSProperties } from "react";
import type { ChatTurn } from "../../api/types.js";

const baseStyle: CSSProperties = {
  maxWidth: "34rem",
  minWidth: 0,
  padding: "0.6rem 0.9rem",
  borderRadius: "0.8rem",
  fontSize: "0.92rem",
  lineHeight: 1.45,
  whiteSpace: "pre-wrap",
  // A pasted URL or other long unbroken token would otherwise force the
  // bubble wider than maxWidth (and past the panel's edge) instead of
  // wrapping — "anywhere" breaks even without a natural word boundary,
  // unlike break-word, which only breaks a token too long to fit at all.
  overflowWrap: "anywhere",
};

export function MessageBubble({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <div
        style={{
          ...baseStyle,
          background: isUser ? "var(--accent)" : "var(--bg-inset)",
          color: isUser ? "var(--accent-contrast)" : "var(--text)",
          border: isUser ? "none" : "1px solid var(--border)",
        }}
      >
        {turn.content}
      </div>
    </div>
  );
}

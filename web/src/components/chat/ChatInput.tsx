import { useState, type FormEvent } from "react";

export function ChatInput({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [value, setValue] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) {
      return;
    }
    onSend(trimmed);
    setValue("");
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", gap: "0.5rem" }}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        placeholder="Tell me about a delayed or cancelled flight…"
        style={{
          flex: 1,
          padding: "0.6rem 0.8rem",
          borderRadius: "0.6rem",
          border: "1px solid var(--border)",
          background: "var(--bg)",
          color: "var(--text)",
          fontSize: "0.92rem",
        }}
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        style={{
          padding: "0.6rem 1.1rem",
          borderRadius: "0.6rem",
          border: "none",
          background: "var(--accent)",
          color: "var(--accent-contrast)",
          fontWeight: 600,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled || !value.trim() ? 0.6 : 1,
        }}
      >
        Send
      </button>
    </form>
  );
}

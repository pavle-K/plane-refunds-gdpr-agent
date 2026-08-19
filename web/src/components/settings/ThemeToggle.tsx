import { useState } from "react";
import { applyThemePreference, loadThemePreference, type ThemePreference } from "../../lib/theme.js";

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(loadThemePreference);

  function choose(value: ThemePreference) {
    setPreference(value);
    applyThemePreference(value);
  }

  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: "0.5rem", overflow: "hidden" }}>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => choose(option.value)}
          style={{
            padding: "0.4rem 0.8rem",
            border: "none",
            background: preference === option.value ? "var(--accent)" : "transparent",
            color: preference === option.value ? "var(--accent-contrast)" : "var(--text)",
            fontSize: "0.85rem",
            cursor: "pointer",
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

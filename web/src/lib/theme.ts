export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "prg_theme";

/** Reads the user's saved choice — "system" (the default, no explicit
 * choice saved) defers entirely to styles/theme.css's prefers-color-scheme
 * block rather than this module trying to detect/track OS theme changes
 * itself. */
export function loadThemePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** Sets (or clears, for "system") the data-theme attribute theme.css keys
 * off, and persists the choice. Call once on startup with the loaded
 * preference, and again on every user change. */
export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
  localStorage.setItem(STORAGE_KEY, preference);
}

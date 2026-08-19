import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { queryClient } from "./lib/queryClient.js";
import { applyThemePreference, loadThemePreference } from "./lib/theme.js";
import "./styles/theme.css";

// index.html's inline script already set data-theme synchronously to avoid a
// flash of the wrong theme on load — this just brings the persisted
// ThemeToggle state in sync with that, and is a no-op for the "system"
// default the inline script deliberately leaves untouched.
applyThemePreference(loadThemePreference());

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches any render-time exception below it and shows a recoverable message
 * instead of leaving the whole app blank. React unmounts everything below
 * the nearest error boundary on an uncaught render error — with none
 * anywhere in the tree (the gap this fixes), that "nearest boundary" is
 * nothing, so a single bad response anywhere took down the entire app,
 * permanently, across every page, since client-side routing never gets a
 * chance to re-render a crashed tree. A full navigation (the Reload button)
 * is the only reliable recovery once React has unmounted, so that's what
 * this offers rather than trying to reset in place.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled error in the UI:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: "28rem", margin: "4rem auto", padding: "1.5rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.2rem", margin: "0 0 0.5rem" }}>Something went wrong</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", margin: 0 }}>
            {this.state.error.message || "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={() => window.location.assign("/")}
            style={{
              marginTop: "1.25rem",
              padding: "0.55rem 1.1rem",
              borderRadius: "0.5rem",
              border: "none",
              background: "var(--accent)",
              color: "var(--accent-contrast)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

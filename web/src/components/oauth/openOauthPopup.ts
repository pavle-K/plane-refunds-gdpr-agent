import { queryClient } from "../../lib/queryClient.js";
import { EMAIL_CONNECTIONS_QUERY_KEY } from "../../api/useEmailConnections.js";

export interface OauthPopupResult {
  /** true when window.open itself returned null — almost always a popup
   * blocker, since this is only ever called from a click handler. */
  blocked: boolean;
}

/** How often to check whether the popup has closed — see the fallback note
 * below. Frequent enough to feel instant, cheap enough not to matter. */
const POPUP_CLOSED_POLL_MS = 400;

/**
 * Opens the backend's real OAuth authorization URL in a popup and refetches
 * the email-connections query once the flow is done, two ways:
 *
 * 1. Listens for the "connected" confirmation the callback page posts back
 *    (see buildEmailConnectedPostMessageScript, src/api/routes/oauth.routes.ts).
 * 2. Falls back to polling whether the popup window itself has closed — the
 *    callback page closes itself right after that postMessage call regardless
 *    of whether the message was actually deliverable, so this fires even when
 *    (1) doesn't. That gap is real, not hypothetical: postMessage only
 *    delivers when its target origin matches the opener's actual origin, and
 *    in local dev (`npm run dev:web`) the opener is Vite's own origin
 *    (e.g. :5173) while the callback page's target origin is WEB_APP_ORIGIN/
 *    PUBLIC_URL (the backend's origin) — different origins unless
 *    WEB_APP_ORIGIN is explicitly set to the frontend's dev origin. Same-origin
 *    production (the default topology) doesn't have this gap, but the poll
 *    costs nothing there either, so it isn't conditioned on environment.
 */
export function openOauthPopup(authorizationUrl: string): OauthPopupResult {
  const popup = window.open(authorizationUrl, "oauth-connect", "width=480,height=640");
  if (!popup) {
    return { blocked: true };
  }

  let settled = false;
  function refetchOnce() {
    if (settled) return;
    settled = true;
    window.removeEventListener("message", onMessage);
    clearInterval(pollHandle);
    void queryClient.invalidateQueries({ queryKey: EMAIL_CONNECTIONS_QUERY_KEY });
  }

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) {
      return;
    }
    const data = event.data as { type?: string } | undefined;
    if (data?.type !== "email_connected") {
      return;
    }
    refetchOnce();
  };
  window.addEventListener("message", onMessage);

  const pollHandle = window.setInterval(() => {
    if (popup.closed) {
      refetchOnce();
    }
  }, POPUP_CLOSED_POLL_MS);

  return { blocked: false };
}

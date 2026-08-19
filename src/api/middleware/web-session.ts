import { randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env } from "../../config/env.js";

export const WEB_SESSION_COOKIE_NAME = "prg_web_session";

// 400 days — Chrome's own cap on Set-Cookie Max-Age, so this is effectively
// "as long as any browser will honor" rather than an arbitrary shorter value.
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

declare global {
  // Express's own documented pattern for augmenting Request — there's no
  // ES-module equivalent for extending an ambient global namespace like this.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by createWebSessionMiddleware for every /api/web/* request —
       * the externalId half of channel: "web" identity resolution
       * (see src/api/routes/web/resolve-web-user.ts). */
      webSessionId?: string;
    }
  }
}

/**
 * Stands in for a login system on the web channel: an opaque, random,
 * httpOnly cookie issued silently on first visit, used purely as the
 * `externalId` half of `channel: "web"` — the same trust model this app
 * already applies to a Telegram chat id (whoever holds the identifier is
 * trusted to be that user). It is deliberately NOT signed/encrypted: it
 * carries no claims of its own, only a lookup key into channel_identities,
 * so there's nothing in it to tamper with. A forged/guessed value just
 * resolves to a fresh empty identity (or, at 256 bits of entropy, is
 * infeasible to guess into an existing one) — the same risk profile already
 * accepted for Telegram's chat id.
 *
 * Only acts on /api/web/* — every other route (webhooks, the OAuth callback,
 * healthz) calls next() immediately, unaffected. Also closes the CSRF gap
 * SameSite=Lax leaves open on older browsers: in production, a state-changing
 * request carrying an Origin header that doesn't match this app's own origin
 * is rejected outright. A request with no Origin header (same-origin fetches
 * in most browsers, and any non-browser client) passes through — this is
 * defense-in-depth, not the primary defense.
 *
 * Production-only, deliberately: this compares Origin against
 * WEB_APP_ORIGIN/PUBLIC_URL, which is only actually the SPA's own origin once
 * it's served from this same process (the default same-origin production
 * topology — see server.ts). In local dev the SPA runs on Vite's own port
 * (e.g. :5173) proxying to this server (e.g. :3000) — Origin is legitimately
 * Vite's port there, which is NOT PUBLIC_URL (PUBLIC_URL describes where this
 * backend itself is publicly reachable, e.g. for OAuth redirect URIs).
 * Enforcing the comparison in dev would 403 every real request from the dev
 * SPA; SameSite=Lax alone is sufficient protection for a local dev loop with
 * no real cross-origin attacker.
 */
export function createWebSessionMiddleware(): RequestHandler {
  const allowedOrigin = env.WEB_APP_ORIGIN ?? env.PUBLIC_URL;

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api/web/")) {
      next();
      return;
    }

    if (env.NODE_ENV === "production" && req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.header("Origin");
      if (origin && allowedOrigin && origin !== allowedOrigin) {
        res.sendStatus(403);
        return;
      }
    }

    const existing = req.cookies?.[WEB_SESSION_COOKIE_NAME];
    if (typeof existing === "string" && existing.length > 0) {
      req.webSessionId = existing;
      next();
      return;
    }

    const sessionId = randomBytes(32).toString("base64url");
    res.cookie(WEB_SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE_MS,
      path: "/api/web",
    });
    req.webSessionId = sessionId;
    next();
  };
}

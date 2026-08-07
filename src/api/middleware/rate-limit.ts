import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

/**
 * Public, unauthenticated-by-default endpoints (the OAuth callback, channel
 * webhooks) have no login of their own — a webhook is protected only by a
 * shared secret header, and an OAuth callback only by a single-use state
 * token. This is a coarse, cheap backstop against flooding/resource
 * exhaustion, not the primary defense (a 122-bit random state token isn't
 * something rate limiting meaningfully protects against guessing — it's
 * already infeasible to guess regardless). Per-IP, generous enough not to
 * bother a real user, tight enough to blunt a scripted flood.
 *
 * Each call returns a fresh middleware instance with its own counters, so
 * the OAuth callback route and the webhook route(s) don't share a budget.
 */
export function createPublicEndpointRateLimiter(limit = 60): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

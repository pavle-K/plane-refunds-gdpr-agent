import { env } from "../../config/env.js";
import type { EmailProviderName } from "../../db/repositories/email-connection.repo.js";

/** Local-machine loopback flow (scripts/connect-email.ts, npm run chat's
 * connect_email tool today) — must exactly match the redirect URI registered
 * with each OAuth app for local dev. Unrelated to the hosted flow below;
 * kept for local dev convenience even once the hosted flow exists. */
export const REDIRECT_URI = "http://localhost:8765/callback";

export class MissingPublicUrlError extends Error {
  constructor() {
    super("PUBLIC_URL must be set in .env to build a hosted OAuth redirect URI — see .env.example");
    this.name = "MissingPublicUrlError";
  }
}

/**
 * Hosted flow redirect URI — provider-specific (unlike REDIRECT_URI above) so
 * the callback route can infer which provider a request is for from the path
 * alone: GET /oauth/gmail/callback vs GET /oauth/outlook/callback. Must
 * exactly match the redirect URI registered in Google Cloud Console / Azure.
 */
export function getHostedRedirectUri(provider: EmailProviderName): string {
  if (!env.PUBLIC_URL) {
    throw new MissingPublicUrlError();
  }
  return `${env.PUBLIC_URL.replace(/\/+$/, "")}/oauth/${provider}/callback`;
}

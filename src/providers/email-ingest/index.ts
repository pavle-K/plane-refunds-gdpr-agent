import type { EmailIngestProvider } from "./email-ingest.port.js";
import { FakeEmailIngestAdapter } from "./fake.adapter.js";
import { GmailAdapter } from "./gmail.adapter.js";
import { OutlookAdapter } from "./outlook.adapter.js";
import { EMAIL_OAUTH_PROVIDERS } from "./oauth-providers.js";
import { refreshAccessToken } from "./oauth-flow.js";
import { EmailConnectionRepo, type EmailConnection, type EmailProviderName } from "../../db/repositories/email-connection.repo.js";
import { env } from "../../config/env.js";

export * from "./email-ingest.port.js";
export { FakeEmailIngestAdapter } from "./fake.adapter.js";
export { GmailAdapter } from "./gmail.adapter.js";
export { OutlookAdapter } from "./outlook.adapter.js";
export * from "./booking-parser.js";

const REFRESH_BUFFER_MS = 60_000;

function buildTokenAccessor(provider: EmailProviderName, connection: EmailConnection, repo: EmailConnectionRepo) {
  let accessToken = connection.accessToken;
  let expiresAtUtc = connection.accessTokenExpiresAtUtc;
  const clientId = provider === "gmail" ? env.GMAIL_OAUTH_CLIENT_ID : env.OUTLOOK_OAUTH_CLIENT_ID;
  const clientSecret = provider === "gmail" ? env.GMAIL_OAUTH_CLIENT_SECRET : env.OUTLOOK_OAUTH_CLIENT_SECRET;

  return async (): Promise<string> => {
    if (Date.now() < expiresAtUtc.getTime() - REFRESH_BUFFER_MS) {
      return accessToken;
    }
    if (!clientId || !clientSecret) {
      throw new Error(`${provider} access token expired and OAuth client credentials are no longer configured`);
    }
    const { tokenEndpoint } = EMAIL_OAUTH_PROVIDERS[provider].buildConfig(clientId, clientSecret, "http://unused/");
    const refreshed = await refreshAccessToken({ tokenEndpoint, clientId, clientSecret }, connection.refreshToken);
    accessToken = refreshed.accessToken;
    expiresAtUtc = refreshed.expiresAtUtc;
    await repo.updateAccessToken(provider, connection.emailAddress, accessToken, expiresAtUtc);
    return accessToken;
  };
}

/**
 * Auto-detects a connected inbox (gmail checked first, then outlook — see
 * scripts/connect-email.ts) and returns the matching real adapter, refreshing
 * the access token transparently on expiry. Falls back to the fake adapter if
 * nothing is connected, TOKEN_ENCRYPTION_KEY isn't set, or NODE_ENV is "test".
 */
export async function createEmailIngestProvider(): Promise<EmailIngestProvider> {
  if (env.NODE_ENV === "test" || !env.TOKEN_ENCRYPTION_KEY) {
    return new FakeEmailIngestAdapter();
  }

  const repo = new EmailConnectionRepo();
  for (const provider of ["gmail", "outlook"] as const) {
    const connection = await repo.findByProvider(provider);
    if (!connection) {
      continue;
    }
    const getAccessToken = buildTokenAccessor(provider, connection, repo);
    return provider === "gmail" ? new GmailAdapter(getAccessToken) : new OutlookAdapter(getAccessToken);
  }

  return new FakeEmailIngestAdapter();
}

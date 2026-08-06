/**
 * One-time (or re-run-when-refresh-token-revoked) setup: authorizes read-only
 * access to a Gmail or Outlook inbox and stores the resulting tokens (encrypted)
 * in Postgres, for the real gmail.adapter.ts/outlook.adapter.ts to use.
 *
 * Prerequisites (see the OAuth app registration steps you were given):
 *   - GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET, or
 *   - OUTLOOK_OAUTH_CLIENT_ID / OUTLOOK_OAUTH_CLIENT_SECRET
 *   - TOKEN_ENCRYPTION_KEY (see .env.example for how to generate one)
 *   - The registered redirect URI must be exactly http://localhost:8765/callback
 *
 * Usage: npx tsx scripts/connect-email.ts gmail
 *        npx tsx scripts/connect-email.ts outlook
 */
import { runAuthorizationCodeFlow } from "../src/providers/email-ingest/oauth-flow.js";
import { EMAIL_OAUTH_PROVIDERS } from "../src/providers/email-ingest/oauth-providers.js";
import { EmailConnectionRepo } from "../src/db/repositories/email-connection.repo.js";
import { REDIRECT_URI } from "../src/providers/email-ingest/oauth-redirect-uri.js";
import { env } from "../src/config/env.js";
import { pool, assertDatabaseConfigured } from "../src/db/client.js";

async function main() {
  assertDatabaseConfigured();

  const provider = process.argv[2];
  if (provider !== "gmail" && provider !== "outlook") {
    throw new Error("Usage: npx tsx scripts/connect-email.ts <gmail|outlook>");
  }

  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new Error("Set TOKEN_ENCRYPTION_KEY in .env first — see .env.example for how to generate one.");
  }

  const clientId = provider === "gmail" ? env.GMAIL_OAUTH_CLIENT_ID : env.OUTLOOK_OAUTH_CLIENT_ID;
  const clientSecret = provider === "gmail" ? env.GMAIL_OAUTH_CLIENT_SECRET : env.OUTLOOK_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const prefix = provider.toUpperCase();
    throw new Error(`Set ${prefix}_OAUTH_CLIENT_ID and ${prefix}_OAUTH_CLIENT_SECRET in .env first.`);
  }

  const setup = EMAIL_OAUTH_PROVIDERS[provider];
  const config = setup.buildConfig(clientId, clientSecret, REDIRECT_URI);

  console.log(`Starting ${provider} authorization (redirect: ${REDIRECT_URI})...`);
  const tokens = await runAuthorizationCodeFlow(config);

  console.log("Fetching the connected account's email address...");
  const emailAddress = await setup.fetchEmailAddress(tokens.accessToken);

  const repo = new EmailConnectionRepo();
  await repo.upsert({
    provider,
    emailAddress,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAtUtc: tokens.expiresAtUtc,
  });

  console.log(`\nConnected ${emailAddress} (${provider}). Tokens stored encrypted in Postgres.`);
  await pool.end();
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

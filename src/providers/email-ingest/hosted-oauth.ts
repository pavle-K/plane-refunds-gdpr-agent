import { randomBytes, createHash } from "node:crypto";
import { buildAuthorizationUrl, exchangeCodeForTokens } from "./oauth-flow.js";
import { EMAIL_OAUTH_PROVIDERS } from "./oauth-providers.js";
import { getHostedRedirectUri } from "./oauth-redirect-uri.js";
import { OAuthPendingFlowRepo } from "../../db/repositories/oauth-pending-flow.repo.js";
import { EmailConnectionRepo, type EmailProviderName } from "../../db/repositories/email-connection.repo.js";
import { DbAuditLog } from "../../compliance/audit-log.js";
import { env } from "../../config/env.js";
import { ok, err, type Result } from "../../lib/result.js";

/**
 * The hosted (non-blocking, multi-tenant) OAuth flow: a chat tool calls
 * buildHostedAuthorizationUrl to get a link to hand a remote user immediately,
 * and the public callback route (src/api/routes/oauth.routes.ts) calls
 * completeHostedFlow once Google/Microsoft redirects back. Unlike
 * oauth-flow.ts's runAuthorizationCodeFlow, neither function blocks waiting
 * for a redirect — the "waiting" is just a row in oauth_pending_flows.
 */

const PENDING_FLOW_TTL_MINUTES = 15;

export class MissingOAuthCredentialsError extends Error {
  constructor(provider: EmailProviderName) {
    super(`${provider.toUpperCase()}_OAUTH_CLIENT_ID/_SECRET must be set in .env to start a hosted OAuth flow.`);
    this.name = "MissingOAuthCredentialsError";
  }
}

function requireProviderCredentials(provider: EmailProviderName): { clientId: string; clientSecret: string } {
  const clientId = provider === "gmail" ? env.GMAIL_OAUTH_CLIENT_ID : env.OUTLOOK_OAUTH_CLIENT_ID;
  const clientSecret = provider === "gmail" ? env.GMAIL_OAUTH_CLIENT_SECRET : env.OUTLOOK_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new MissingOAuthCredentialsError(provider);
  }
  return { clientId, clientSecret };
}

/** RFC 7636 PKCE pair — code_verifier is a high-entropy random string, sent
 * only at token-exchange time; code_challenge is its SHA-256 hash, sent on
 * the (public, browser-visible) authorization URL. Defense-in-depth on top of
 * the state nonce: even a leaked authorization URL can't be redeemed for
 * tokens without the verifier, which never left this server. */
function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export interface HostedAuthorizationUrl {
  authorizationUrl: string;
  expiresInMinutes: number;
}

/** Starts a hosted OAuth flow: creates a server-held pending-flow row (its id
 * IS the `state` handed to the provider and back — see schema.ts's
 * oauth_pending_flows doc comment) and returns a link immediately. No
 * blocking wait, unlike oauth-flow.ts's local loopback flow. */
export async function buildHostedAuthorizationUrl(
  userId: string,
  channelIdentityId: string,
  provider: EmailProviderName,
): Promise<HostedAuthorizationUrl> {
  const { clientId, clientSecret } = requireProviderCredentials(provider);
  const redirectUri = getHostedRedirectUri(provider);
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const expiresAtUtc = new Date(Date.now() + PENDING_FLOW_TTL_MINUTES * 60_000);

  const state = await new OAuthPendingFlowRepo().create({
    userId,
    channelIdentityId,
    provider,
    codeVerifier,
    expiresAtUtc,
  });

  const config = EMAIL_OAUTH_PROVIDERS[provider].buildConfig(clientId, clientSecret, redirectUri);
  const authorizationUrl = buildAuthorizationUrl(config, state, { codeChallenge });

  return { authorizationUrl, expiresInMinutes: PENDING_FLOW_TTL_MINUTES };
}

export type CompleteHostedFlowError =
  | { type: "not_found" }
  | { type: "already_consumed" }
  | { type: "expired" }
  | { type: "provider_denied"; providerError: string }
  | { type: "missing_code" }
  | { type: "exchange_failed"; message: string };

export interface CompletedHostedFlow {
  provider: EmailProviderName;
  emailAddress: string;
  channelIdentityId: string;
  userId: string;
  /** Set when this mailbox was previously owned by a different user — see the
   * "reassign + audit log" policy in the plan this segment implements. */
  reassignedFromUserId: string | null;
}

/**
 * Completes a hosted OAuth flow from the callback route. Validates the
 * pending-flow row (exists, not expired, not already consumed) BEFORE doing
 * anything else — a flow is marked consumed on every terminal outcome
 * (success, provider denial, or a failed exchange) so the same state/code
 * can never be replayed, even after a failure.
 */
export async function completeHostedFlow(
  state: string,
  params: { code: string | null; error: string | null },
): Promise<Result<CompletedHostedFlow, CompleteHostedFlowError>> {
  const pendingFlowRepo = new OAuthPendingFlowRepo();
  const flow = await pendingFlowRepo.findById(state);

  if (!flow) {
    return err({ type: "not_found" });
  }
  if (flow.consumedAtUtc) {
    return err({ type: "already_consumed" });
  }
  if (flow.expiresAtUtc.getTime() < Date.now()) {
    return err({ type: "expired" });
  }

  if (params.error) {
    await pendingFlowRepo.markConsumed(state);
    return err({ type: "provider_denied", providerError: params.error });
  }
  if (!params.code) {
    await pendingFlowRepo.markConsumed(state);
    return err({ type: "missing_code" });
  }

  const { clientId, clientSecret } = requireProviderCredentials(flow.provider);
  const redirectUri = getHostedRedirectUri(flow.provider);
  const config = EMAIL_OAUTH_PROVIDERS[flow.provider].buildConfig(clientId, clientSecret, redirectUri);

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(config, params.code, flow.codeVerifier ? { codeVerifier: flow.codeVerifier } : {});
  } catch (cause) {
    await pendingFlowRepo.markConsumed(state);
    return err({ type: "exchange_failed", message: cause instanceof Error ? cause.message : String(cause) });
  }

  const emailAddress = await EMAIL_OAUTH_PROVIDERS[flow.provider].fetchEmailAddress(tokens.accessToken);

  const emailConnectionRepo = new EmailConnectionRepo();
  const existingConnection = await emailConnectionRepo.findByEmailAddress(emailAddress);
  const reassignedFromUserId =
    existingConnection && existingConnection.userId !== flow.userId ? existingConnection.userId : null;

  await emailConnectionRepo.upsert({
    userId: flow.userId,
    provider: flow.provider,
    emailAddress,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAtUtc: tokens.expiresAtUtc,
  });

  if (reassignedFromUserId) {
    await new DbAuditLog().record({
      userId: flow.userId,
      entryType: "mailbox_reassigned",
      payload: { emailAddress, provider: flow.provider, fromUserId: reassignedFromUserId, toUserId: flow.userId },
    });
  }

  await pendingFlowRepo.markConsumed(state);

  return ok({
    provider: flow.provider,
    emailAddress,
    channelIdentityId: flow.channelIdentityId,
    userId: flow.userId,
    reassignedFromUserId,
  });
}

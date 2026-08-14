import type { OAuthProviderConfig } from "./oauth-flow.js";
import type { EmailProviderName } from "../../db/repositories/email-connection.repo.js";

export interface ProviderOAuthSetup {
  buildConfig: (clientId: string, clientSecret: string, redirectUri: string) => OAuthProviderConfig;
  fetchEmailAddress: (accessToken: string) => Promise<string>;
  /** Best-effort, app-initiated revocation of the OAuth grant itself — not
   * just deleting our local copy of the token, but invalidating it with the
   * provider so the grant no longer shows up under the user's own connected-
   * apps list either. Not every provider offers this for an app to call
   * (Microsoft doesn't, for consumer accounts — see the outlook entry below),
   * so this is optional; callers should delete their local copy regardless of
   * whether it's present or what it returns, and tell the user to revoke it
   * themselves via the provider's account settings when it isn't. */
  revokeToken?: (token: string) => Promise<boolean>;
}

/** Shared between scripts/connect-email.ts (initial authorization) and the
 * email-ingest factory (token refresh) — one source of truth for endpoints/scopes. */
export const EMAIL_OAUTH_PROVIDERS: Record<EmailProviderName, ProviderOAuthSetup> = {
  gmail: {
    buildConfig: (clientId, clientSecret, redirectUri) => ({
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      clientId,
      clientSecret,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      redirectUri,
      extraAuthParams: { access_type: "offline", prompt: "consent" },
    }),
    // Gmail's own profile endpoint returns the address and is covered by the
    // gmail.readonly scope already requested above — no separate identity
    // scope needed (userinfo.email isn't part of the Gmail API's scope set,
    // so it wouldn't show up under "Gmail API" in the consent screen's scope
    // picker anyway).
    fetchEmailAddress: async (accessToken) => {
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const json = (await res.json()) as { emailAddress: string };
      return json.emailAddress;
    },
    // Revoking either the access or refresh token invalidates the whole
    // grant — pass the refresh token (the longer-lived credential
    // representing the grant itself) rather than the access token.
    revokeToken: async (token) => {
      const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return res.ok;
    },
  },
  outlook: {
    // No revokeToken here: Microsoft's identity platform doesn't expose an
    // app-initiated single-grant revoke endpoint for consumer accounts (the
    // closest equivalent, revoking sign-in sessions, needs admin-level Graph
    // permissions this app doesn't have and shouldn't request just for this).
    // Disconnecting still deletes the locally stored token; the caller tells
    // the user to revoke it themselves via https://account.live.com/consent/Manage.
    buildConfig: (clientId, clientSecret, redirectUri) => ({
      authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      clientId,
      clientSecret,
      scope: "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access",
      redirectUri,
    }),
    fetchEmailAddress: async (accessToken) => {
      const res = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const json = (await res.json()) as { mail?: string; userPrincipalName?: string };
      return json.mail ?? json.userPrincipalName ?? "unknown";
    },
  },
};

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

/**
 * Generic OAuth2 authorization-code + refresh-token mechanics (RFC 6749),
 * parameterized per provider — Gmail and Outlook both implement standard OAuth2,
 * just with different endpoints/scopes. The interactive piece (runAuthorizationCodeFlow)
 * is the "installed app" / loopback pattern — same approach as `gcloud auth login`:
 * spin up a local HTTP listener, send the user to the provider's consent screen,
 * catch the redirect, exchange the code for tokens.
 */

export interface OAuthProviderConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Must be an http://localhost:<port>/<path> URI registered with the provider. */
  redirectUri: string;
  extraAuthParams?: Record<string, string>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtUtc: Date;
}

export class OAuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

/** codeChallenge (PKCE, RFC 7636) is optional — the local loopback flow below
 * doesn't use it; the hosted flow (hosted-oauth.ts) always does, as
 * defense-in-depth on top of the state nonce. */
export function buildAuthorizationUrl(config: OAuthProviderConfig, state: string, options?: { codeChallenge?: string }): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  if (options?.codeChallenge) {
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function exchangeCodeForTokens(
  config: OAuthProviderConfig,
  code: string,
  options?: { codeVerifier?: string },
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
  });
  if (options?.codeVerifier) {
    body.set("code_verifier", options.codeVerifier);
  }

  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new OAuthFlowError(`Token exchange failed: HTTP ${response.status} — ${await response.text()}`);
  }

  const json = (await response.json()) as TokenEndpointResponse;
  if (!json.refresh_token) {
    throw new OAuthFlowError(
      "No refresh_token in the response — for Google, the auth URL needs access_type=offline&prompt=consent; " +
        "for Microsoft, the scope needs to include offline_access.",
    );
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAtUtc: new Date(Date.now() + json.expires_in * 1000),
  };
}

/** Runs the local-listener consent flow; resolves once tokens are obtained. */
export async function runAuthorizationCodeFlow(
  config: OAuthProviderConfig,
  options?: { state?: string },
): Promise<OAuthTokens> {
  const redirectUrl = new URL(config.redirectUri);
  const port = Number(redirectUrl.port);
  const path = redirectUrl.pathname;
  const state = options?.state ?? randomBytes(16).toString("hex");

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) {
        return;
      }
      const requestUrl = new URL(req.url, `http://localhost:${port}`);
      if (requestUrl.pathname !== path) {
        res.writeHead(404).end();
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const returnedState = requestUrl.searchParams.get("state");
      const returnedCode = requestUrl.searchParams.get("code");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(`Authorization failed: ${error}`);
        server.close();
        reject(new OAuthFlowError(`Authorization failed: ${error}`));
        return;
      }
      if (returnedState !== state || !returnedCode) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid state or missing code.");
        server.close();
        reject(new OAuthFlowError("OAuth state mismatch or missing code — possible CSRF or a stale link"));
        return;
      }

      res
        .writeHead(200, { "Content-Type": "text/plain" })
        .end("Authorized — you can close this tab and return to the terminal.");
      server.close();
      resolve(returnedCode);
    });

    server.listen(port, () => {
      const authUrl = buildAuthorizationUrl(config, state);
      console.log("\nOpen this URL to authorize:\n");
      console.log(authUrl);
      console.log(`\nWaiting for the redirect on http://localhost:${port}${path} ...`);
    });

    server.on("error", reject);
  });

  return exchangeCodeForTokens(config, code);
}

export async function refreshAccessToken(
  config: Pick<OAuthProviderConfig, "tokenEndpoint" | "clientId" | "clientSecret">,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAtUtc: Date }> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new OAuthFlowError(`Token refresh failed: HTTP ${response.status} — ${await response.text()}`);
  }

  const json = (await response.json()) as Pick<TokenEndpointResponse, "access_token" | "expires_in">;
  return { accessToken: json.access_token, expiresAtUtc: new Date(Date.now() + json.expires_in * 1000) };
}

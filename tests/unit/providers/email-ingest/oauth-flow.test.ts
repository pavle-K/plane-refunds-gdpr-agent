import { describe, it, expect, afterEach, vi } from "vitest";
import { get } from "node:http";
import {
  runAuthorizationCodeFlow,
  refreshAccessToken,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  OAuthFlowError,
  type OAuthProviderConfig,
} from "../../../../src/providers/email-ingest/oauth-flow.js";

/** Real HTTP request, bypassing the global-fetch stub used for the token-exchange
 * mock below — this simulates the browser hitting the loopback redirect, which
 * must be a genuine network call, not intercepted by the fetch mock. */
function hitCallback(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
}

function mockTokenFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE_CONFIG: OAuthProviderConfig = {
  authorizationEndpoint: "https://example.com/authorize",
  tokenEndpoint: "https://example.com/token",
  clientId: "client-1",
  clientSecret: "secret-1",
  scope: "read",
  redirectUri: "http://localhost:8799/callback",
};

describe("buildAuthorizationUrl", () => {
  it("builds a URL with the core OAuth2 params and no PKCE by default", () => {
    const url = new URL(buildAuthorizationUrl(BASE_CONFIG, "state-1"));
    expect(url.origin + url.pathname).toBe("https://example.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(BASE_CONFIG.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
  });

  it("adds PKCE params when a codeChallenge is given", () => {
    const url = new URL(buildAuthorizationUrl(BASE_CONFIG, "state-1", { codeChallenge: "challenge-abc" }));
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("includes extraAuthParams", () => {
    const url = new URL(buildAuthorizationUrl({ ...BASE_CONFIG, extraAuthParams: { access_type: "offline" } }, "s"));
    expect(url.searchParams.get("access_type")).toBe("offline");
  });
});

describe("exchangeCodeForTokens", () => {
  it("exchanges a code for tokens", async () => {
    mockTokenFetchOnce({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
    const tokens = await exchangeCodeForTokens(BASE_CONFIG, "code-1");
    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.refreshToken).toBe("refresh-1");
  });

  it("sends code_verifier in the token request body when provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await exchangeCodeForTokens(BASE_CONFIG, "code-1", { codeVerifier: "verifier-xyz" });

    const call = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(call[1].body as string);
    expect(body.get("code_verifier")).toBe("verifier-xyz");
  });

  it("omits code_verifier from the request body when not provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await exchangeCodeForTokens(BASE_CONFIG, "code-1");

    const call = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(call[1].body as string);
    expect(body.has("code_verifier")).toBe(false);
  });

  it("throws OAuthFlowError when no refresh_token comes back", async () => {
    mockTokenFetchOnce({ access_token: "access-1", expires_in: 3600 });
    await expect(exchangeCodeForTokens(BASE_CONFIG, "code-1")).rejects.toThrow(OAuthFlowError);
  });

  it("throws OAuthFlowError on a non-ok response", async () => {
    mockTokenFetchOnce({ error: "invalid_grant" }, 400);
    await expect(exchangeCodeForTokens(BASE_CONFIG, "code-1")).rejects.toThrow(OAuthFlowError);
  });
});

describe("refreshAccessToken", () => {
  it("exchanges a refresh token for a new access token", async () => {
    mockTokenFetchOnce({ access_token: "new-access-token", expires_in: 3600 });

    const result = await refreshAccessToken(BASE_CONFIG, "refresh-token-1");

    expect(result.accessToken).toBe("new-access-token");
    expect(result.expiresAtUtc.getTime()).toBeGreaterThan(Date.now());
  });

  it("throws OAuthFlowError on a non-ok response", async () => {
    mockTokenFetchOnce({ error: "invalid_grant" }, 400);
    await expect(refreshAccessToken(BASE_CONFIG, "bad-token")).rejects.toThrow(OAuthFlowError);
  });
});

describe("runAuthorizationCodeFlow", () => {
  it("captures the redirect, validates state, and exchanges the code for tokens", async () => {
    mockTokenFetchOnce({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
    });

    const flowPromise = runAuthorizationCodeFlow(BASE_CONFIG, { state: "known-state" });

    // Give the loopback server a moment to start listening, then simulate the
    // provider's redirect the way a real browser would hit it.
    await new Promise((r) => setTimeout(r, 50));
    await hitCallback("http://localhost:8799/callback?code=auth-code-1&state=known-state");

    const tokens = await flowPromise;
    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.refreshToken).toBe("refresh-1");
  });

  it("rejects on a state mismatch (possible CSRF)", async () => {
    const flowPromise = runAuthorizationCodeFlow({ ...BASE_CONFIG, redirectUri: "http://localhost:8798/callback" });
    flowPromise.catch(() => {}); // mark handled immediately — the real assertion is below
    await new Promise((r) => setTimeout(r, 50));

    await hitCallback("http://localhost:8798/callback?code=x&state=wrong-state");

    await expect(flowPromise).rejects.toThrow(OAuthFlowError);
  });

  it("rejects when the provider reports an authorization error", async () => {
    const flowPromise = runAuthorizationCodeFlow({ ...BASE_CONFIG, redirectUri: "http://localhost:8797/callback" });
    flowPromise.catch(() => {}); // mark handled immediately — the real assertion is below
    await new Promise((r) => setTimeout(r, 50));

    await hitCallback("http://localhost:8797/callback?error=access_denied");

    await expect(flowPromise).rejects.toThrow(OAuthFlowError);
  });
});

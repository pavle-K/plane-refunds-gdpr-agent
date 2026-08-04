import { describe, it, expect, afterEach, vi } from "vitest";
import { get } from "node:http";
import {
  runAuthorizationCodeFlow,
  refreshAccessToken,
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

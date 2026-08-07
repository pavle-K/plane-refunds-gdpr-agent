/**
 * Runs against a real local Postgres, same skip convention as the rest of
 * this repo's integration suite. Spins up the actual Express router on an
 * ephemeral port and hits it with real HTTP requests (no supertest dependency
 * needed — same "real network call" approach oauth-flow.test.ts already uses
 * for the local loopback flow), stubbing only the outbound provider network
 * calls (token exchange, email-address lookup).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { env } from "../../../src/config/env.js";
import { createOAuthCallbackRouter } from "../../../src/api/routes/oauth.routes.js";
import { buildHostedAuthorizationUrl } from "../../../src/providers/email-ingest/hosted-oauth.js";
import { OAuthPendingFlowRepo } from "../../../src/db/repositories/oauth-pending-flow.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";

const canRun = Boolean(
  env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY && env.PUBLIC_URL && env.GMAIL_OAUTH_CLIENT_ID && env.GMAIL_OAUTH_CLIENT_SECRET,
);

/** Only the outbound calls to Google are stubbed — everything else (notably
 * the test's own request to the local Express server below) falls through to
 * the real fetch, since vi.stubGlobal("fetch", ...) replaces fetch globally
 * for both. */
function stubGmailFetch(emailAddress: string) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("oauth2.googleapis.com/token")) {
        const body = { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      if (url.includes("gmail/v1/users/me/profile")) {
        return { ok: true, status: 200, json: async () => ({ emailAddress }) };
      }
      return realFetch(input, init);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.skipIf(!canRun)("GET /oauth/:provider/callback (real Postgres, ephemeral Express server)", () => {
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = express();
    app.use(createOAuthCallbackRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function makeUserAndIdentity() {
    const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("telegram", `test-${randomUUID()}`);
    const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
    if (!userId) throw new Error("expected a linked user");
    return { userId, channelIdentityId };
  }

  it("returns a confirmation page and stores the connection on success", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const emailAddress = `route-${randomUUID()}@example.com`;
    stubGmailFetch(emailAddress);

    const { authorizationUrl } = await buildHostedAuthorizationUrl(userId, channelIdentityId, "gmail");
    const state = new URL(authorizationUrl).searchParams.get("state")!;

    const res = await fetch(`${baseUrl}/oauth/gmail/callback?state=${state}&code=auth-code-1`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(emailAddress);
    expect(body).toContain("Connected");
  });

  it("returns 404 for an unknown provider", async () => {
    const res = await fetch(`${baseUrl}/oauth/yahoo/callback?state=x&code=y`);
    expect(res.status).toBe(404);
  });

  it("returns 400 without leaking internals when the state is missing", async () => {
    const res = await fetch(`${baseUrl}/oauth/gmail/callback?code=y`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain("undefined");
  });

  it("returns 400 for an unknown/expired state", async () => {
    const res = await fetch(`${baseUrl}/oauth/gmail/callback?state=${randomUUID()}&code=y`);
    expect(res.status).toBe(400);
  });

  it("returns a friendly 200 page when the provider reports the user declined", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const state = await new OAuthPendingFlowRepo().create({
      userId,
      channelIdentityId,
      provider: "gmail",
      codeVerifier: "verifier",
      expiresAtUtc: new Date(Date.now() + 15 * 60_000),
    });

    const res = await fetch(`${baseUrl}/oauth/gmail/callback?state=${state}&error=access_denied`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("access_denied");
  });
});

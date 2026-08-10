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
import { FakeChannelAdapter } from "../../../src/channels/fake.adapter.js";
import { FakeLlmClient } from "../../../src/agent/llm/fake.adapter.js";

const canRun = Boolean(
  env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY && env.PUBLIC_URL && env.GMAIL_OAUTH_CLIENT_ID && env.GMAIL_OAUTH_CLIENT_SECRET,
);

/** The post-connect notification is sent after the HTTP response is already
 * flushed (see oauth.routes.ts's sendConnectedNotification) — the client's
 * fetch() can resolve before that background work lands, so assertions on it
 * poll briefly instead of assuming it's already done. */
async function waitFor(condition: () => boolean, timeoutMs = 2000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`waitForAsync: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

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
  const fakeAdapter = new FakeChannelAdapter();
  // Shared across every test in this describe block — each test enqueues
  // exactly what it needs and awaits full completion before returning, so the
  // queue never bleeds between tests (vitest runs `it`s sequentially here).
  const llm = new FakeLlmClient();

  beforeAll(async () => {
    app = express();
    app.use(createOAuthCallbackRouter(llm, () => fakeAdapter));
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
    llm.enqueueFinalText("Connected.");

    const { authorizationUrl } = await buildHostedAuthorizationUrl(userId, channelIdentityId, "gmail");
    const state = new URL(authorizationUrl).searchParams.get("state")!;

    const res = await fetch(`${baseUrl}/oauth/gmail/callback?state=${state}&code=auth-code-1`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(emailAddress);
    expect(body).toContain("Connected");
  });

  it("pushes the LLM-resumed confirmation to the originating chat and appends it to conversation history", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const identity = await new ConversationRepo().findChannelIdentity(channelIdentityId);
    const emailAddress = `notify-${randomUUID()}@example.com`;
    stubGmailFetch(emailAddress);

    // Nothing was pending, so the resumption call should just confirm — this
    // exact text comes from the (fake) LLM, not a hardcoded string in the route.
    const confirmationText = "You're connected! Nothing else to do right now.";
    llm.enqueueFinalText(confirmationText);

    const { authorizationUrl } = await buildHostedAuthorizationUrl(userId, channelIdentityId, "gmail");
    const state = new URL(authorizationUrl).searchParams.get("state")!;

    const sentBefore = fakeAdapter.sentMessages.length;
    const res = await fetch(`${baseUrl}/oauth/gmail/callback?state=${state}&code=auth-code-1`);
    expect(res.status).toBe(200);

    await waitFor(() => fakeAdapter.sentMessages.length > sentBefore);
    const sent = fakeAdapter.sentMessages[fakeAdapter.sentMessages.length - 1]!;
    expect(sent.externalUserId).toBe(identity?.externalId);
    expect(sent.text).toBe(confirmationText);

    const conversationRepo = new ConversationRepo();
    await waitForAsync(async () => {
      const history = await conversationRepo.loadHistory(channelIdentityId);
      return history.some((h) => h.role === "assistant" && h.content === sent.text);
    });
  });

  it("resumes a pending request immediately after connecting, instead of just confirming", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const emailAddress = `resume-${randomUUID()}@example.com`;
    stubGmailFetch(emailAddress);

    // Same shape a real prior turn would leave behind: the user asked
    // something that needed a connected inbox, and got sent a link instead.
    const conversationRepo = new ConversationRepo();
    await conversationRepo.appendTurn(channelIdentityId, "user", "is my email connected?");
    await conversationRepo.appendTurn(channelIdentityId, "assistant", "Not yet — here's a link to connect it.");

    const resumedText = "All set — I checked, and your Gmail is now connected.";
    llm.enqueueToolCall({ name: "get_email_connection_status", input: {} });
    llm.enqueueFinalText(resumedText);

    const { authorizationUrl } = await buildHostedAuthorizationUrl(userId, channelIdentityId, "gmail");
    const state = new URL(authorizationUrl).searchParams.get("state")!;

    const sentBefore = fakeAdapter.sentMessages.length;
    const res = await fetch(`${baseUrl}/oauth/gmail/callback?state=${state}&code=auth-code-1`);
    expect(res.status).toBe(200);

    await waitFor(() => fakeAdapter.sentMessages.length > sentBefore);
    const sent = fakeAdapter.sentMessages[fakeAdapter.sentMessages.length - 1]!;
    expect(sent.text).toBe(resumedText);
    expect(llm.toolCallsMade.some((c) => c.name === "get_email_connection_status")).toBe(true);
  });

  it("falls back to a fixed confirmation if the LLM resumption call fails", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const emailAddress = `fallback-${randomUUID()}@example.com`;
    stubGmailFetch(emailAddress);
    // Deliberately nothing enqueued — FakeLlmClient throws "no more tool-loop
    // steps queued", exercising sendConnectedNotification's fallback path.

    const { authorizationUrl } = await buildHostedAuthorizationUrl(userId, channelIdentityId, "gmail");
    const state = new URL(authorizationUrl).searchParams.get("state")!;

    const sentBefore = fakeAdapter.sentMessages.length;
    const res = await fetch(`${baseUrl}/oauth/gmail/callback?state=${state}&code=auth-code-1`);
    expect(res.status).toBe(200);

    await waitFor(() => fakeAdapter.sentMessages.length > sentBefore);
    const sent = fakeAdapter.sentMessages[fakeAdapter.sentMessages.length - 1]!;
    expect(sent.text).toContain(emailAddress);
    expect(sent.text).toContain("Connected");
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

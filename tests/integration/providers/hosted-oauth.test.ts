/**
 * Runs against a real local Postgres — skipped when DATABASE_URL,
 * TOKEN_ENCRYPTION_KEY, PUBLIC_URL, or the Gmail OAuth client credentials
 * aren't set, same convention as the rest of this repo's integration suite.
 * Token exchange and the email-address lookup are the only network calls, and
 * those are stubbed (same pattern as oauth-flow.test.ts) — no real Google
 * request happens.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { env } from "../../../src/config/env.js";
import { buildHostedAuthorizationUrl, completeHostedFlow } from "../../../src/providers/email-ingest/hosted-oauth.js";
import { OAuthPendingFlowRepo } from "../../../src/db/repositories/oauth-pending-flow.repo.js";
import { EmailConnectionRepo } from "../../../src/db/repositories/email-connection.repo.js";
import { AuditRepo } from "../../../src/db/repositories/audit.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";

const canRun = Boolean(
  env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY && env.PUBLIC_URL && env.GMAIL_OAUTH_CLIENT_ID && env.GMAIL_OAUTH_CLIENT_SECRET,
);

function stubGmailFetch(emailAddress: string, tokenBody: Record<string, unknown> = { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("oauth2.googleapis.com/token")) {
        return {
          ok: true,
          status: 200,
          json: async () => tokenBody,
          text: async () => JSON.stringify(tokenBody),
        };
      }
      if (url.includes("gmail/v1/users/me/profile")) {
        return { ok: true, status: 200, json: async () => ({ emailAddress }) };
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.skipIf(!canRun)("hosted OAuth flow (real Postgres, stubbed provider network calls)", () => {
  const userRepo = new UserRepo();
  const conversationRepo = new ConversationRepo();
  const pendingFlowRepo = new OAuthPendingFlowRepo();
  const emailConnectionRepo = new EmailConnectionRepo();
  const auditRepo = new AuditRepo();

  async function makeUserAndIdentity() {
    const channelIdentityId = await conversationRepo.getOrCreateIdentity("telegram", `test-${randomUUID()}`);
    const userId = await userRepo.getUserIdForChannelIdentity(channelIdentityId);
    if (!userId) throw new Error("expected a linked user");
    return { userId, channelIdentityId };
  }

  it("buildHostedAuthorizationUrl creates a pending flow and returns a link with PKCE + state", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();

    const result = await buildHostedAuthorizationUrl(userId, channelIdentityId, "gmail");
    const url = new URL(result.authorizationUrl);

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("code_challenge")).toBe(true);
    expect(result.expiresInMinutes).toBeGreaterThan(0);

    const state = url.searchParams.get("state");
    const flow = state ? await pendingFlowRepo.findById(state) : null;
    expect(flow?.userId).toBe(userId);
    expect(flow?.channelIdentityId).toBe(channelIdentityId);
    expect(flow?.consumedAtUtc).toBeNull();
  });

  it("completes the flow, stores the connection, and marks the pending flow consumed", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const emailAddress = `hosted-${randomUUID()}@example.com`;
    stubGmailFetch(emailAddress);

    const { authorizationUrl } = await buildHostedAuthorizationUrl(userId, channelIdentityId, "gmail");
    const state = new URL(authorizationUrl).searchParams.get("state")!;

    const result = await completeHostedFlow(state, { code: "auth-code-1", error: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.emailAddress).toBe(emailAddress);
    expect(result.value.userId).toBe(userId);
    expect(result.value.channelIdentityId).toBe(channelIdentityId);
    expect(result.value.reassignedFromUserId).toBeNull();

    const stored = await emailConnectionRepo.findByUserAndProvider(userId, "gmail");
    expect(stored?.emailAddress).toBe(emailAddress);
    expect(stored?.accessToken).toBe("access-1");

    const flow = await pendingFlowRepo.findById(state);
    expect(flow?.consumedAtUtc).not.toBeNull();
  });

  it("rejects an unknown state", async () => {
    const result = await completeHostedFlow(randomUUID(), { code: "x", error: null });
    expect(result).toEqual({ ok: false, error: { type: "not_found" } });
  });

  it("rejects a replayed (already-consumed) state", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    stubGmailFetch(`hosted-${randomUUID()}@example.com`);

    const { authorizationUrl } = await buildHostedAuthorizationUrl(userId, channelIdentityId, "gmail");
    const state = new URL(authorizationUrl).searchParams.get("state")!;

    const first = await completeHostedFlow(state, { code: "auth-code-1", error: null });
    expect(first.ok).toBe(true);

    const replay = await completeHostedFlow(state, { code: "auth-code-1", error: null });
    expect(replay).toEqual({ ok: false, error: { type: "already_consumed" } });
  });

  it("rejects an expired pending flow without ever exchanging the code", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const expiredState = await pendingFlowRepo.create({
      userId,
      channelIdentityId,
      provider: "gmail",
      codeVerifier: "verifier",
      expiresAtUtc: new Date(Date.now() - 60_000),
    });

    const result = await completeHostedFlow(expiredState, { code: "auth-code-1", error: null });

    expect(result).toEqual({ ok: false, error: { type: "expired" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks the flow consumed and reports provider_denied when the user declines consent", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const state = await pendingFlowRepo.create({
      userId,
      channelIdentityId,
      provider: "gmail",
      codeVerifier: "verifier",
      expiresAtUtc: new Date(Date.now() + 15 * 60_000),
    });

    const result = await completeHostedFlow(state, { code: null, error: "access_denied" });

    expect(result).toEqual({ ok: false, error: { type: "provider_denied", providerError: "access_denied" } });
    const flow = await pendingFlowRepo.findById(state);
    expect(flow?.consumedAtUtc).not.toBeNull();
  });

  it("reassigns a mailbox and writes an audit log entry when a different user connects an already-owned inbox", async () => {
    const original = await makeUserAndIdentity();
    const newOwner = await makeUserAndIdentity();
    const emailAddress = `reassign-${randomUUID()}@example.com`;

    stubGmailFetch(emailAddress);
    const originalFlow = await buildHostedAuthorizationUrl(original.userId, original.channelIdentityId, "gmail");
    const originalState = new URL(originalFlow.authorizationUrl).searchParams.get("state")!;
    const first = await completeHostedFlow(originalState, { code: "auth-code-1", error: null });
    expect(first.ok).toBe(true);

    stubGmailFetch(emailAddress);
    const newOwnerFlow = await buildHostedAuthorizationUrl(newOwner.userId, newOwner.channelIdentityId, "gmail");
    const newOwnerState = new URL(newOwnerFlow.authorizationUrl).searchParams.get("state")!;
    const second = await completeHostedFlow(newOwnerState, { code: "auth-code-2", error: null });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.reassignedFromUserId).toBe(original.userId);

    const originalNowHasNoConnection = await emailConnectionRepo.findByUserAndProvider(original.userId, "gmail");
    expect(originalNowHasNoConnection).toBeNull();

    const newOwnerConnection = await emailConnectionRepo.findByUserAndProvider(newOwner.userId, "gmail");
    expect(newOwnerConnection?.emailAddress).toBe(emailAddress);

    const auditEntries = await auditRepo.listByUser(newOwner.userId);
    const reassignmentEntry = auditEntries.find((e) => e.entryType === "mailbox_reassigned");
    expect(reassignmentEntry).toBeTruthy();
    expect(reassignmentEntry?.payload).toMatchObject({
      emailAddress,
      fromUserId: original.userId,
      toUserId: newOwner.userId,
    });
  });
});

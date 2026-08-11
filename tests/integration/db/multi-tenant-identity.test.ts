/**
 * Runs against a real local Postgres — skipped automatically when DATABASE_URL
 * or TOKEN_ENCRYPTION_KEY isn't set (same convention as the rest of this repo:
 * see commit "Fix: make DATABASE_URL optional so unit tests don't require
 * Postgres to be configured" — CI doesn't provision a database, so this suite
 * only runs where a developer has one configured locally). Exercises the
 * Segment 1 schema/repos: users, channel_identities ownership, email_connections
 * ownership + reassignment, oauth_pending_flows, and the claims ownership
 * mirror. Each test uses fresh random identifiers, so runs don't collide with
 * each other or with prior runs; there's no cleanup/rollback since these repos
 * don't support an injectable transaction yet (see CLAUDE.md §5.5 — a proper
 * ephemeral-schema/testcontainers integration setup is separate future work).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { EmailConnectionRepo } from "../../../src/db/repositories/email-connection.repo.js";
import { OAuthPendingFlowRepo } from "../../../src/db/repositories/oauth-pending-flow.repo.js";
import { ClaimRepo } from "../../../src/db/repositories/claim.repo.js";

const canRun = Boolean(env.DATABASE_URL) && Boolean(env.TOKEN_ENCRYPTION_KEY);

describe.skipIf(!canRun)("multi-tenant identity & ownership schema (real Postgres)", () => {
  const userRepo = new UserRepo();
  const conversationRepo = new ConversationRepo();
  const emailConnectionRepo = new EmailConnectionRepo();
  const oauthPendingFlowRepo = new OAuthPendingFlowRepo();
  const claimRepo = new ClaimRepo();

  it("creates a user and links it the first time a channel identity is seen", async () => {
    const externalId = `test-${randomUUID()}`;
    const channelIdentityId = await conversationRepo.getOrCreateIdentity("telegram", externalId);
    const userId = await userRepo.getUserIdForChannelIdentity(channelIdentityId);
    expect(userId).toBeTruthy();
  });

  it("resolves the same identity and user on repeat contact from the same (channel, externalId)", async () => {
    const externalId = `test-${randomUUID()}`;
    const firstIdentityId = await conversationRepo.getOrCreateIdentity("telegram", externalId);
    const firstUserId = await userRepo.getUserIdForChannelIdentity(firstIdentityId);

    const secondIdentityId = await conversationRepo.getOrCreateIdentity("telegram", externalId);
    const secondUserId = await userRepo.getUserIdForChannelIdentity(secondIdentityId);

    expect(secondIdentityId).toBe(firstIdentityId);
    expect(secondUserId).toBe(firstUserId);
  });

  it("gives two different channel identities two different users", async () => {
    const identityA = await conversationRepo.getOrCreateIdentity("telegram", `test-${randomUUID()}`);
    const identityB = await conversationRepo.getOrCreateIdentity("telegram", `test-${randomUUID()}`);
    const userA = await userRepo.getUserIdForChannelIdentity(identityA);
    const userB = await userRepo.getUserIdForChannelIdentity(identityB);
    expect(userA).not.toBe(userB);
  });

  it("scopes email connections to their owning user and leaves other users' connections untouched", async () => {
    const userAId = await userRepo.createUser();
    const userBId = await userRepo.createUser();

    await emailConnectionRepo.upsert({
      userId: userAId,
      provider: "gmail",
      emailAddress: `a-${randomUUID()}@example.com`,
      accessToken: "access-a",
      refreshToken: "refresh-a",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });

    const userAConnection = await emailConnectionRepo.findByUserAndProvider(userAId, "gmail");
    const userBConnection = await emailConnectionRepo.findByUserAndProvider(userBId, "gmail");

    expect(userAConnection?.userId).toBe(userAId);
    expect(userBConnection).toBeNull();
  });

  it("reassigns a mailbox to whoever most recently connects it via a real OAuth completion", async () => {
    const originalOwnerId = await userRepo.createUser();
    const newOwnerId = await userRepo.createUser();
    const emailAddress = `reassign-${randomUUID()}@example.com`;

    await emailConnectionRepo.upsert({
      userId: originalOwnerId,
      provider: "gmail",
      emailAddress,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });

    const beforeReassignment = await emailConnectionRepo.findByEmailAddress(emailAddress);
    expect(beforeReassignment?.userId).toBe(originalOwnerId);

    await emailConnectionRepo.upsert({
      userId: newOwnerId,
      provider: "gmail",
      emailAddress,
      accessToken: "access-2",
      refreshToken: "refresh-2",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });

    const afterReassignment = await emailConnectionRepo.findByEmailAddress(emailAddress);
    expect(afterReassignment?.userId).toBe(newOwnerId);
    expect(afterReassignment?.accessToken).toBe("access-2");

    const originalOwnerLookup = await emailConnectionRepo.findByUserAndProvider(originalOwnerId, "gmail");
    expect(originalOwnerLookup).toBeNull();
  });

  it("creates, finds, and single-use-marks an OAuth pending flow", async () => {
    const userId = await userRepo.createUser();
    const channelIdentityId = await conversationRepo.getOrCreateIdentity("telegram", `test-${randomUUID()}`);

    const flowId = await oauthPendingFlowRepo.create({
      userId,
      channelIdentityId,
      provider: "gmail",
      codeVerifier: "verifier-abc",
      expiresAtUtc: new Date(Date.now() + 15 * 60_000),
    });

    const found = await oauthPendingFlowRepo.findById(flowId);
    expect(found?.userId).toBe(userId);
    expect(found?.consumedAtUtc).toBeNull();

    await oauthPendingFlowRepo.markConsumed(flowId);
    const afterConsume = await oauthPendingFlowRepo.findById(flowId);
    expect(afterConsume?.consumedAtUtc).not.toBeNull();
  });

  it("tracks claim ownership and reports the most recently touched claim for a user", async () => {
    const userId = await userRepo.createUser();
    const olderThreadId = `claim-${randomUUID()}`;
    const newerThreadId = `claim-${randomUUID()}`;

    await claimRepo.create(olderThreadId, userId, olderThreadId, "draft");
    await claimRepo.create(newerThreadId, userId, newerThreadId, "draft");
    await claimRepo.updateStatus(newerThreadId, "pending_approval");

    const mostRecent = await claimRepo.findMostRecentForUser(userId);
    expect(mostRecent?.id).toBe(newerThreadId);
    expect(mostRecent?.status).toBe("pending_approval");

    const found = await claimRepo.findById(olderThreadId);
    expect(found?.userId).toBe(userId);
  });
});

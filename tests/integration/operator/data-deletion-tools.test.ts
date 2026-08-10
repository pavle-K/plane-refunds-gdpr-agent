/**
 * Runs against a real local Postgres, same skip convention as the rest of
 * this repo's integration suite. Covers disconnect_email and forget_my_data
 * as a two-phase flow: dispatch() only ever REQUESTS (creates a pending
 * confirmation, deletes/disconnects nothing), and executeConfirmedAction()
 * is the only path that actually performs the action — see
 * schema.ts's pending_confirmations doc comment and
 * src/operator/session.ts's deterministic confirmation gate for why. Only
 * the outbound Google revoke call is stubbed (never a real network call).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { env } from "../../../src/config/env.js";
import { OperatorTools } from "../../../src/operator/tools.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { EmailConnectionRepo } from "../../../src/db/repositories/email-connection.repo.js";
import { ConsentRepo } from "../../../src/db/repositories/consent.repo.js";
import { ClaimRepo } from "../../../src/db/repositories/claim.repo.js";
import { AuditRepo } from "../../../src/db/repositories/audit.repo.js";
import { PendingConfirmationRepo } from "../../../src/db/repositories/pending-confirmation.repo.js";

const canRun = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY);

function stubGmailRevoke(ok: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("oauth2.googleapis.com/revoke")) {
        return { ok, status: ok ? 200 : 400 };
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeOperatorTools() {
  const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("telegram", `test-${randomUUID()}`);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) throw new Error("expected a linked user");
  return { tools: new OperatorTools(userId, channelIdentityId), userId, channelIdentityId };
}

describe.skipIf(!canRun)("disconnect_email / forget_my_data — request phase (dispatch)", () => {
  it("disconnect_email reports not_connected and creates no pending confirmation when nothing is connected", async () => {
    const { tools, userId } = await makeOperatorTools();
    const result = await tools.dispatch("disconnect_email", { provider: "gmail" });
    expect(result).toEqual({ status: "not_connected" });
    expect(await new PendingConfirmationRepo().findActiveForUser(userId)).toBeNull();
  });

  it("disconnect_email requests confirmation and does NOT disconnect anything yet", async () => {
    const { tools, userId } = await makeOperatorTools();
    const emailAddress = `request-disconnect-${randomUUID()}@example.com`;
    await new EmailConnectionRepo().upsert({
      userId,
      provider: "gmail",
      emailAddress,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });

    const result = (await tools.dispatch("disconnect_email", { provider: "gmail" })) as {
      status: string;
      confirmationPrompt: string;
    };

    expect(result.status).toBe("confirmation_required");
    expect(result.confirmationPrompt).toContain(emailAddress);

    // Nothing actually happened yet.
    const stillConnected = await new EmailConnectionRepo().findByUserAndProvider(userId, "gmail");
    expect(stillConnected?.emailAddress).toBe(emailAddress);

    const pending = await new PendingConfirmationRepo().findActiveForUser(userId);
    expect(pending?.actionType).toBe("disconnect_email");
    expect(pending?.actionParams).toEqual({ provider: "gmail" });
  });

  it("forget_my_data requests confirmation, mentions specifics, and does NOT delete anything yet", async () => {
    const { tools, userId, channelIdentityId } = await makeOperatorTools();
    const emailAddress = `request-forget-${randomUUID()}@example.com`;
    await new EmailConnectionRepo().upsert({
      userId,
      provider: "gmail",
      emailAddress,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });
    await new ConsentRepo().record({ userId, policyVersion: "v1-placeholder", channel: "telegram" });
    await new ConversationRepo().appendTurn(channelIdentityId, "user", "hello");

    const draftClaimId = `claim-${randomUUID()}`;
    await new ClaimRepo().create(draftClaimId, userId, "draft");

    const result = (await tools.dispatch("forget_my_data", {})) as { status: string; confirmationPrompt: string };

    expect(result.status).toBe("confirmation_required");
    expect(result.confirmationPrompt).toContain(emailAddress);
    expect(result.confirmationPrompt).toContain("1 claim");

    // Nothing actually happened yet — everything is still there.
    expect(await new EmailConnectionRepo().findByUserAndProvider(userId, "gmail")).not.toBeNull();
    expect(await new ConsentRepo().hasConsented(userId)).toBe(true);
    expect(await new ConversationRepo().loadHistory(channelIdentityId)).not.toEqual([]);
    expect(await new ClaimRepo().findById(draftClaimId)).not.toBeNull();

    const pending = await new PendingConfirmationRepo().findActiveForUser(userId);
    expect(pending?.actionType).toBe("forget_my_data");
  });
});

describe.skipIf(!canRun)("disconnect_email — execution phase (executeConfirmedAction)", () => {
  it("revokes with Google, deletes the local connection, and records an audit entry", async () => {
    const { tools, userId } = await makeOperatorTools();
    const emailAddress = `disconnect-${randomUUID()}@example.com`;
    await new EmailConnectionRepo().upsert({
      userId,
      provider: "gmail",
      emailAddress,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });
    stubGmailRevoke(true);

    const result = (await tools.executeConfirmedAction("disconnect_email", { provider: "gmail" })) as {
      disconnected: boolean;
      revokedWithProvider: boolean;
    };

    expect(result.disconnected).toBe(true);
    expect(result.revokedWithProvider).toBe(true);

    const stillThere = await new EmailConnectionRepo().findByUserAndProvider(userId, "gmail");
    expect(stillThere).toBeNull();

    const auditEntries = await new AuditRepo().listByUser(userId);
    const disconnectEntry = auditEntries.find((e) => e.entryType === "email_disconnected");
    expect(disconnectEntry).toBeTruthy();
    expect(disconnectEntry?.payload).toMatchObject({ provider: "gmail", emailAddress, revokedWithProvider: true });
  });

  it("still deletes the local connection even when the provider revoke call fails", async () => {
    const { tools, userId } = await makeOperatorTools();
    await new EmailConnectionRepo().upsert({
      userId,
      provider: "gmail",
      emailAddress: `revoke-fails-${randomUUID()}@example.com`,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });
    stubGmailRevoke(false);

    const result = (await tools.executeConfirmedAction("disconnect_email", { provider: "gmail" })) as {
      disconnected: boolean;
      revokedWithProvider: boolean;
      note?: string;
    };

    expect(result.disconnected).toBe(true);
    expect(result.revokedWithProvider).toBe(false);
    expect(result.note).toBeTruthy();

    const stillThere = await new EmailConnectionRepo().findByUserAndProvider(userId, "gmail");
    expect(stillThere).toBeNull();
  });

  it("deletes locally without attempting revocation for Outlook (no revoke API available)", async () => {
    const { tools, userId } = await makeOperatorTools();
    await new EmailConnectionRepo().upsert({
      userId,
      provider: "outlook",
      emailAddress: `outlook-${randomUUID()}@example.com`,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });

    const result = (await tools.executeConfirmedAction("disconnect_email", { provider: "outlook" })) as {
      disconnected: boolean;
      revokedWithProvider: boolean;
    };

    expect(result.disconnected).toBe(true);
    expect(result.revokedWithProvider).toBe(false);
    const stillThere = await new EmailConnectionRepo().findByUserAndProvider(userId, "outlook");
    expect(stillThere).toBeNull();
  });
});

describe.skipIf(!canRun)("forget_my_data — execution phase (executeConfirmedAction)", () => {
  it("succeeds with nothing to erase", async () => {
    const { tools } = await makeOperatorTools();
    const result = (await tools.executeConfirmedAction("forget_my_data", {})) as {
      disconnectedEmails: unknown[];
      deletedClaimCount: number;
    };
    expect(result.deletedClaimCount).toBe(0);
  });

  it("deletes email connection, chat history, and consent; deletes never-sent claims but keeps sent ones", async () => {
    const { tools, userId, channelIdentityId } = await makeOperatorTools();
    const emailConnectionRepo = new EmailConnectionRepo();
    const consentRepo = new ConsentRepo();
    const conversationRepo = new ConversationRepo();
    const claimRepo = new ClaimRepo();

    stubGmailRevoke(true);
    await emailConnectionRepo.upsert({
      userId,
      provider: "gmail",
      emailAddress: `forget-${randomUUID()}@example.com`,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });
    await consentRepo.record({ userId, policyVersion: "v1-placeholder", channel: "telegram" });
    await conversationRepo.appendTurn(channelIdentityId, "user", "hello");
    await conversationRepo.appendTurn(channelIdentityId, "assistant", "hi there");

    const draftClaimId = `claim-${randomUUID()}`;
    await claimRepo.create(draftClaimId, userId, "draft");
    const sentClaimId = `claim-${randomUUID()}`;
    await claimRepo.create(sentClaimId, userId, "draft");
    await claimRepo.updateStatus(sentClaimId, "sent");

    const result = (await tools.executeConfirmedAction("forget_my_data", {})) as {
      disconnectedEmails: unknown[];
      deletedClaimCount: number;
      keptClaims: { count: number; reason: string } | null;
    };

    expect(result.disconnectedEmails).toHaveLength(1);
    expect(result.deletedClaimCount).toBe(1);
    expect(result.keptClaims).toEqual({ count: 1, reason: expect.stringContaining("legal") });

    expect(await emailConnectionRepo.findByUserAndProvider(userId, "gmail")).toBeNull();
    expect(await consentRepo.hasConsented(userId)).toBe(false);
    expect(await conversationRepo.loadHistory(channelIdentityId)).toEqual([]);
    expect(await claimRepo.findById(draftClaimId)).toBeNull();

    const keptClaim = await claimRepo.findById(sentClaimId);
    expect(keptClaim?.status).toBe("sent");

    const auditEntries = await new AuditRepo().listByUser(userId);
    const erasureEntry = auditEntries.find((e) => e.entryType === "data_erasure");
    expect(erasureEntry).toBeTruthy();
    expect(erasureEntry?.payload).toMatchObject({
      deletedClaimIds: [draftClaimId],
      keptClaimIds: [sentClaimId],
    });
  });

  it("keeps claims in every post-send status, not just 'sent'", async () => {
    const { tools, userId } = await makeOperatorTools();
    const claimRepo = new ClaimRepo();

    const postSendStatuses = ["sent", "awaiting_response", "rejected", "rebutting", "escalated", "accepted", "paid"];
    const postSendIds: string[] = [];
    for (const status of postSendStatuses) {
      const id = `claim-${randomUUID()}`;
      await claimRepo.create(id, userId, "draft");
      await claimRepo.updateStatus(id, status);
      postSendIds.push(id);
    }
    const declinedId = `claim-${randomUUID()}`;
    await claimRepo.create(declinedId, userId, "draft");
    await claimRepo.updateStatus(declinedId, "declined");

    const result = (await tools.executeConfirmedAction("forget_my_data", {})) as { deletedClaimCount: number };
    expect(result.deletedClaimCount).toBe(1); // only the declined one

    for (const id of postSendIds) {
      expect(await claimRepo.findById(id)).not.toBeNull();
    }
    expect(await claimRepo.findById(declinedId)).toBeNull();
  });
});

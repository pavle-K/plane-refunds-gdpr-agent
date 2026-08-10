/**
 * Runs against a real local Postgres, same skip convention as the rest of
 * this repo's integration suite.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { PendingConfirmationRepo } from "../../../src/db/repositories/pending-confirmation.repo.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";

const canRun = Boolean(env.DATABASE_URL);

describe.skipIf(!canRun)("PendingConfirmationRepo (real Postgres)", () => {
  async function makeUserAndIdentity() {
    const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("telegram", `test-${randomUUID()}`);
    const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
    if (!userId) throw new Error("expected a linked user");
    return { userId, channelIdentityId };
  }

  it("finds an unexpired confirmation and returns null once none exists", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const repo = new PendingConfirmationRepo();

    expect(await repo.findActiveForUser(userId)).toBeNull();

    const id = await repo.create({
      userId,
      channelIdentityId,
      actionType: "forget_my_data",
      actionParams: {},
      expiresAtUtc: new Date(Date.now() + 5 * 60_000),
    });

    const found = await repo.findActiveForUser(userId);
    expect(found?.id).toBe(id);
    expect(found?.actionType).toBe("forget_my_data");
  });

  it("does not treat an expired confirmation as active", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const repo = new PendingConfirmationRepo();

    await repo.create({
      userId,
      channelIdentityId,
      actionType: "disconnect_email",
      actionParams: { provider: "gmail" },
      expiresAtUtc: new Date(Date.now() - 1000), // already expired
    });

    expect(await repo.findActiveForUser(userId)).toBeNull();
  });

  it("resolve() consumes a confirmation so it can never be found or acted on again", async () => {
    const { userId, channelIdentityId } = await makeUserAndIdentity();
    const repo = new PendingConfirmationRepo();

    const id = await repo.create({
      userId,
      channelIdentityId,
      actionType: "forget_my_data",
      actionParams: {},
      expiresAtUtc: new Date(Date.now() + 5 * 60_000),
    });

    await repo.resolve(id);

    expect(await repo.findActiveForUser(userId)).toBeNull();
  });
});

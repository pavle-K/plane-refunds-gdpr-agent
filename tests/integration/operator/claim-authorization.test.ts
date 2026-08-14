/**
 * Runs against a real local Postgres, same skip convention as the rest of
 * this repo's integration suite. Proves the Segment 5 authorization work:
 * one user's OperatorTools instance cannot read or act on another user's
 * email_connections row or claim threadId — a clean, explicit authorization
 * error, never data leakage or a crash. LLM/provider calls are all fake here
 * (createLlmClient/createFlightStatusProvider/etc. all gate on NODE_ENV=test
 * regardless of real keys configured in .env), so start_claim runs the real
 * graph but with fake dependencies — no live network calls.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { OperatorTools, ClaimAuthorizationError } from "../../../src/operator/tools.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { EmailConnectionRepo } from "../../../src/db/repositories/email-connection.repo.js";
import { ClaimRepo } from "../../../src/db/repositories/claim.repo.js";

const canRun = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY);

async function makeOperatorTools() {
  const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("telegram", `test-${randomUUID()}`);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) throw new Error("expected a linked user");
  return { tools: new OperatorTools(userId, channelIdentityId), userId, channelIdentityId };
}

const ONE_SEGMENT = { segments: [{ flightNumber: "BA123", date: "2024-06-15" }] };

describe.skipIf(!canRun)("multi-tenant authorization on OperatorTools (real Postgres)", () => {
  it("does not let one user see another user's email connection", async () => {
    const userA = await makeOperatorTools();
    const userB = await makeOperatorTools();

    await new EmailConnectionRepo().upsert({
      userId: userA.userId,
      provider: "gmail",
      emailAddress: `isolated-${randomUUID()}@example.com`,
      accessToken: "access-a",
      refreshToken: "refresh-a",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });

    const statusForA = (await userA.tools.dispatch("get_email_connection_status", {})) as {
      gmail: { connected: boolean };
    };
    const statusForB = (await userB.tools.dispatch("get_email_connection_status", {})) as {
      gmail: { connected: boolean };
    };

    expect(statusForA.gmail.connected).toBe(true);
    expect(statusForB.gmail.connected).toBe(false);
  });

  it("records ownership on start_claim and lets the owner read their own claim status", async () => {
    const userA = await makeOperatorTools();

    const started = (await userA.tools.dispatch("start_claim", ONE_SEGMENT)) as {
      threadId: string;
      claimStatus: string;
    };

    const claim = await new ClaimRepo().findById(started.threadId);
    expect(claim?.userId).toBe(userA.userId);
    // The status mirror is kept current with the actual graph result, not
    // left at its initial "draft" value.
    expect(claim?.status).toBe(started.claimStatus);

    const status = (await userA.tools.dispatch("get_claim_status", { threadId: started.threadId })) as {
      threadId: string;
    };
    expect(status.threadId).toBe(started.threadId);
  });

  it("denies a different user access to someone else's claim thread on every claim-touching tool", async () => {
    const userA = await makeOperatorTools();
    const userB = await makeOperatorTools();

    const started = (await userA.tools.dispatch("start_claim", ONE_SEGMENT)) as { threadId: string };
    const threadId = started.threadId;

    await expect(userB.tools.dispatch("get_claim_status", { threadId })).rejects.toThrow(ClaimAuthorizationError);
    await expect(
      userB.tools.dispatch("submit_approval_decision", { threadId, action: "decline" }),
    ).rejects.toThrow(ClaimAuthorizationError);
    await expect(userB.tools.dispatch("submit_airline_reply", { threadId, replyText: "hello" })).rejects.toThrow(
      ClaimAuthorizationError,
    );
    await expect(
      userB.tools.dispatch("submit_payment_confirmation", {
        threadId,
        receivedAmountCents: 25000,
        connectedAccountId: "acct_1",
      }),
    ).rejects.toThrow(ClaimAuthorizationError);

    // Denial, not corruption — the thread is still exactly userA's afterward.
    const claim = await new ClaimRepo().findById(threadId);
    expect(claim?.userId).toBe(userA.userId);
  });

  it("rejects an unknown threadId the same way as someone else's (no existence leak)", async () => {
    const userA = await makeOperatorTools();
    await expect(
      userA.tools.dispatch("get_claim_status", { threadId: `claim-${randomUUID()}` }),
    ).rejects.toThrow(ClaimAuthorizationError);
  });

  it("requires a threadId when this user has never started or touched a claim", async () => {
    const userA = await makeOperatorTools();
    await expect(userA.tools.dispatch("get_claim_status", {})).rejects.toThrow(
      "No claim thread specified and none started yet.",
    );
  });
});

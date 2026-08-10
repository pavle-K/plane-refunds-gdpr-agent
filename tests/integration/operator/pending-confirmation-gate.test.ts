/**
 * Runs against a real local Postgres, same skip convention as the rest of
 * this repo's integration suite. This is the direct regression test for the
 * real incident that motivated it: a model calling forget_my_data, getting a
 * confirmation prompt, and then — on the user's "yes" — just generating a
 * confident "done!" without ever calling the tool again. Proves the fix
 * structurally, not just behaviorally: the confirmation turn never reaches
 * the LLM at all, so there is nothing for a model to hallucinate. That's
 * verified by leaving the FakeLlmClient's tool-loop queue EMPTY for the
 * confirmation turn — if session.ts's gate didn't short-circuit before the
 * LLM, FakeLlmClient.completeWithTools would throw "no more tool-loop steps
 * queued" and the test would fail with that error, not a wrong result.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { handleTurn } from "../../../src/operator/session.js";
import { FakeLlmClient } from "../../../src/agent/llm/fake.adapter.js";
import { FakeConsentGate } from "../../../src/compliance/consent.fake.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { EmailConnectionRepo } from "../../../src/db/repositories/email-connection.repo.js";
import { PendingConfirmationRepo } from "../../../src/db/repositories/pending-confirmation.repo.js";

const canRun = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY);

async function setUpConsentedUser() {
  const channel = "telegram";
  const externalId = `test-${randomUUID()}`;
  const channelIdentityId = await new ConversationRepo().getOrCreateIdentity(channel, externalId);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) throw new Error("expected a linked user");
  const consentGate = new FakeConsentGate();
  await consentGate.recordConsent(userId, channel);
  return { channel, externalId, channelIdentityId, userId, consentGate };
}

describe.skipIf(!canRun)("pending-confirmation gate — the LLM cannot cause or fake execution", () => {
  it("actually disconnects on an explicit 'yes', without the confirmation turn ever reaching the LLM", async () => {
    const { channel, externalId, userId, consentGate } = await setUpConsentedUser();
    const llm = new FakeLlmClient();

    await new EmailConnectionRepo().upsert({
      userId,
      provider: "gmail",
      emailAddress: `gate-${randomUUID()}@example.com`,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });

    // Turn 1: the LLM recognizes intent and requests disconnection.
    llm.enqueueToolCall({ name: "disconnect_email", input: { provider: "gmail" } });
    llm.enqueueFinalText("This will disconnect your Gmail. Reply yes to confirm, or anything else to cancel.");
    await handleTurn(llm, { channel, externalId, text: "disconnect my gmail" }, consentGate);

    expect(await new EmailConnectionRepo().findByUserAndProvider(userId, "gmail")).not.toBeNull();
    expect(await new PendingConfirmationRepo().findActiveForUser(userId)).not.toBeNull();

    // Turn 2 — the confirmation. Deliberately nothing queued on the fake LLM:
    // if this reaches the LLM at all, FakeLlmClient throws, and the test fails.
    const responseText = await handleTurn(llm, { channel, externalId, text: "yes" }, consentGate);

    expect(responseText).toContain("Disconnected");
    expect(await new EmailConnectionRepo().findByUserAndProvider(userId, "gmail")).toBeNull();
    expect(await new PendingConfirmationRepo().findActiveForUser(userId)).toBeNull();
  });

  it("does NOT execute when the reply isn't an unambiguous yes, and still never reaches the LLM", async () => {
    const { channel, externalId, userId, consentGate } = await setUpConsentedUser();
    const llm = new FakeLlmClient();

    await new EmailConnectionRepo().upsert({
      userId,
      provider: "gmail",
      emailAddress: `gate-cancel-${randomUUID()}@example.com`,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });

    llm.enqueueToolCall({ name: "disconnect_email", input: { provider: "gmail" } });
    llm.enqueueFinalText("This will disconnect your Gmail. Reply yes to confirm, or anything else to cancel.");
    await handleTurn(llm, { channel, externalId, text: "disconnect my gmail" }, consentGate);

    // Nothing queued here either — same structural guarantee.
    const responseText = await handleTurn(llm, { channel, externalId, text: "actually what does that mean?" }, consentGate);

    expect(responseText).toBe("Okay, cancelled — nothing was changed.");
    expect(await new EmailConnectionRepo().findByUserAndProvider(userId, "gmail")).not.toBeNull();
    expect(await new PendingConfirmationRepo().findActiveForUser(userId)).toBeNull();
  });

  it("a hallucinated success in the reply text cannot fool the system — the deterministic result always wins", async () => {
    // Directly models the real incident: even if we imagine the model WOULD
    // have said something like "Done — I've deleted everything!" on the
    // confirmation turn, it never gets the chance to — there's no queued
    // response for it to say anything at all, and the response the user
    // actually receives is generated by describeConfirmedActionResult from
    // the real tool result, not by the LLM.
    const { channel, externalId, userId, consentGate } = await setUpConsentedUser();
    const llm = new FakeLlmClient();

    await new EmailConnectionRepo().upsert({
      userId,
      provider: "outlook",
      emailAddress: `gate-hallucination-${randomUUID()}@example.com`,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    });

    llm.enqueueToolCall({ name: "disconnect_email", input: { provider: "outlook" } });
    llm.enqueueFinalText("Reply yes to confirm.");
    await handleTurn(llm, { channel, externalId, text: "disconnect outlook" }, consentGate);

    const responseText = await handleTurn(llm, { channel, externalId, text: "yes" }, consentGate);

    // The response is code-generated from the real result, not LLM prose.
    expect(responseText).toMatch(/^Disconnected .+@example\.com\./);
    expect(await new EmailConnectionRepo().findByUserAndProvider(userId, "outlook")).toBeNull();
  });
});

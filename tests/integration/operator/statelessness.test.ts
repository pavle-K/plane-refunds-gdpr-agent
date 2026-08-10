/**
 * Runs against a real local Postgres, same skip convention as the rest of
 * this repo's integration suite. Proves the Segment 6 statelessness work:
 * OperatorTools holds no per-conversation in-memory state (the old
 * lastThreadId field is gone), and session.ts no longer caches one instance
 * per channel identity — so any request can land on any horizontally scaled
 * process and still resolve "the most recently touched claim" correctly via
 * ClaimRepo.findMostRecentForUser, a DB query, not instance memory.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { OperatorTools } from "../../../src/operator/tools.js";
import { handleTurn } from "../../../src/operator/session.js";
import { FakeLlmClient } from "../../../src/agent/llm/fake.adapter.js";
import { FakeConsentGate } from "../../../src/compliance/consent.fake.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";

const canRun = Boolean(env.DATABASE_URL);

const ONE_SEGMENT = { segments: [{ flightNumber: "BA123", date: "2024-06-15" }] };

describe.skipIf(!canRun)("statelessness across OperatorTools instances (real Postgres)", () => {
  it("lets a second, independently-constructed OperatorTools instance see a claim the first one started", async () => {
    const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("telegram", `test-${randomUUID()}`);
    const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
    if (!userId) throw new Error("expected a linked user");

    // Two separately constructed instances, sharing nothing but the DB —
    // simulates two different horizontally-scaled processes handling two
    // different requests from the same conversation.
    const instanceForRequestOne = new OperatorTools(userId, channelIdentityId);
    const instanceForRequestTwo = new OperatorTools(userId, channelIdentityId);

    const started = (await instanceForRequestOne.dispatch("start_claim", ONE_SEGMENT)) as { threadId: string };

    // No threadId given — instanceForRequestTwo has to resolve "the most
    // recently touched claim" itself, with zero shared in-memory state with
    // the instance that actually started it.
    const status = (await instanceForRequestTwo.dispatch("get_claim_status", {})) as { threadId: string };
    expect(status.threadId).toBe(started.threadId);
  });

  it("handleTurn resolves the omitted-threadId case correctly across two separate calls, with no cached OperatorTools between them", async () => {
    const channel = "telegram";
    const externalId = `test-${randomUUID()}`;
    const llm = new FakeLlmClient();
    const consentGate = new FakeConsentGate();

    // Pre-consent (see Segment 2) so these turns reach the LLM/tool loop
    // instead of the consent notice — the identity/consent flow itself is
    // covered separately in tests/integration/operator/consent-gate.test.ts.
    const channelIdentityId = await new ConversationRepo().getOrCreateIdentity(channel, externalId);
    const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
    if (!userId) throw new Error("expected a linked user");
    await consentGate.recordConsent(userId, channel);

    llm.enqueueToolCall({ name: "start_claim", input: ONE_SEGMENT });
    llm.enqueueFinalText("Started your claim.");
    const firstResponse = await handleTurn(llm, { channel, externalId, text: "start a claim" }, consentGate);
    expect(firstResponse).toBe("Started your claim.");

    // A brand-new handleTurn call — session.ts constructs a fresh OperatorTools
    // internally every time (no process-memory Map), so this only works if
    // "the most recently touched claim" comes from Postgres.
    llm.enqueueToolCall({ name: "get_claim_status", input: {} });
    llm.enqueueFinalText("Here's your status.");
    const secondResponse = await handleTurn(llm, { channel, externalId, text: "what's the status?" }, consentGate);

    expect(secondResponse).toBe("Here's your status.");
    expect(llm.toolCallsMade.map((c) => c.name)).toEqual(["start_claim", "get_claim_status"]);
  });
});

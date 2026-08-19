/**
 * Runs against a real local Postgres, same skip convention as the rest of
 * this repo's integration suite. Regression test for a real incident:
 * OperatorTools.startClaim (and every other method that calls
 * this.graph.invoke()/getState()) runs a SEPARATE LangGraph graph — the
 * claim pipeline — from inside the outer conversational agent's own
 * LangChain createAgent tool execution, which is itself a LangGraph run.
 *
 * Without OperatorTools.runGraphCall's AsyncLocalStorage reset, LangGraph
 * detects that ambient context and treats the claim graph as a SUBGRAPH of
 * the outer agent's run: its checkpoints get written under a nested
 * namespace (checkpoint_ns like "tools:<runId>") instead of its own root
 * namespace (""). Every OTHER caller of the same graph — a direct
 * dispatch() call (as most of this test suite uses), scripts/start-claim.ts,
 * or a LATER turn's get_claim_status/submit_approval_decision — invokes it
 * with no such ambient context, and always reads/writes the root namespace.
 * A claim started from inside a live chat turn, without the fix, becomes
 * permanently unreadable by every one of those other callers the moment
 * it's created — and, separately, interrupt() escapes as an uncaught
 * GraphInterrupt instead of pausing the graph normally, since the inner
 * Pregel loop is no longer running as its own top-level invocation.
 *
 * This only reproduces through the real handleTurn -> createAgent tool-call
 * path (see makeConsentedTurn below) — calling OperatorTools.dispatch()
 * directly, as claim-authorization.test.ts and friends do, never nests this
 * way and would pass even without the fix. That's why this needed its own
 * test: nothing else in the suite drives start_claim through the actual
 * agent loop into a real checkpoint write.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, it, expect } from "vitest";
import { db } from "../../../src/db/client.js";
import { env } from "../../../src/config/env.js";
import { handleTurn } from "../../../src/operator/session.js";
import { FakeChatModel } from "../../../src/agent/llm/fake-chat-model.js";
import { FakeConsentGate } from "../../../src/compliance/consent.fake.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { ClaimRepo } from "../../../src/db/repositories/claim.repo.js";

const canRun = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY);

const ONE_SEGMENT = { segments: [{ flightNumber: "BA123", date: "2024-06-15" }] };

async function checkpointNamespacesFor(threadId: string): Promise<string[]> {
  const result = await db.execute(
    sql`select distinct checkpoint_ns from checkpoints where thread_id = ${threadId}`,
  );
  return result.rows.map((row) => row["checkpoint_ns"] as string);
}

describe.skipIf(!canRun)("nested graph invocation checkpoint namespace (real Postgres)", () => {
  it("checkpoints a claim thread under the root namespace even when start_claim runs from inside a real agent tool call", async () => {
    const channel = "telegram";
    const externalId = `test-${randomUUID()}`;
    const model = new FakeChatModel();
    const consentGate = new FakeConsentGate();

    // Pre-consent so this turn reaches the tool loop instead of the consent
    // notice — same convention as statelessness.test.ts.
    const channelIdentityId = await new ConversationRepo().getOrCreateIdentity(channel, externalId);
    const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
    if (!userId) throw new Error("expected a linked user");
    await consentGate.recordConsent(userId, channel);

    model.enqueueToolCall({ name: "start_claim", args: ONE_SEGMENT });
    model.enqueueFinalText("Started your claim.");

    const responseText = await handleTurn(model, { channel, externalId, text: "start a claim" }, consentGate);
    expect(responseText).toBe("Started your claim.");

    const claim = await new ClaimRepo().findMostRecentForUser(userId);
    expect(claim).not.toBeNull();
    const threadId = claim!.id;

    const namespaces = await checkpointNamespacesFor(threadId);
    expect(namespaces.length).toBeGreaterThan(0);
    // The bug this guards against: every namespace here being something like
    // "tools:<uuid>" instead of the graph's own root namespace.
    expect(namespaces).toEqual([""]);
  });
});

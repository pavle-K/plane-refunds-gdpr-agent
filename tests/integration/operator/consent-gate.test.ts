/**
 * Runs against a real local Postgres — skipped when DATABASE_URL isn't set,
 * same convention as tests/integration/db/multi-tenant-identity.test.ts.
 * Drives src/operator/session.ts's handleTurn end to end (real
 * ConversationRepo/UserRepo, a FakeConsentGate so no consents table row is
 * needed to prove the gating, and a spy LlmClient) to prove the actual
 * orchestration wiring: an unconsented user's messages never reach the LLM,
 * and a consented one does.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { handleTurn } from "../../../src/operator/session.js";
import { FakeConsentGate } from "../../../src/compliance/consent.fake.js";
import { CONSENT_NOTICE, CONSENT_WELCOME_TEXT } from "../../../src/compliance/consent.js";
import type { LlmClient, LlmCompleteWithToolsParams } from "../../../src/agent/llm/llm.port.js";

class SpyLlmClient implements LlmClient {
  callCount = 0;

  async complete(): Promise<string> {
    throw new Error("SpyLlmClient.complete is not used by handleTurn");
  }

  async completeWithTools(_params: LlmCompleteWithToolsParams): Promise<string> {
    this.callCount++;
    return "spy-response";
  }
}

describe.skipIf(!env.DATABASE_URL)("consent gate (real Postgres, fake consent store + LLM)", () => {
  it("never calls the LLM before consent, and calls it normally after", async () => {
    const llm = new SpyLlmClient();
    const consentGate = new FakeConsentGate();
    const channel = "telegram";
    const externalId = `test-${randomUUID()}`;

    const firstResponse = await handleTurn(llm, { channel, externalId, text: "hi" }, consentGate);
    expect(firstResponse).toBe(CONSENT_NOTICE);
    expect(llm.callCount).toBe(0);

    const secondResponse = await handleTurn(llm, { channel, externalId, text: "yes" }, consentGate);
    expect(secondResponse).toBe(CONSENT_WELCOME_TEXT);
    expect(llm.callCount).toBe(0);

    const thirdResponse = await handleTurn(llm, { channel, externalId, text: "what's my claim status?" }, consentGate);
    expect(thirdResponse).toBe("spy-response");
    expect(llm.callCount).toBe(1);
  });

  it("re-shows the notice on an ambiguous reply instead of recording consent", async () => {
    const llm = new SpyLlmClient();
    const consentGate = new FakeConsentGate();
    const channel = "telegram";
    const externalId = `test-${randomUUID()}`;

    await handleTurn(llm, { channel, externalId, text: "hi" }, consentGate);
    const response = await handleTurn(llm, { channel, externalId, text: "what data do you keep?" }, consentGate);

    expect(response).toBe(CONSENT_NOTICE);
    expect(llm.callCount).toBe(0);
    expect(consentGate.consentedUserIds.size).toBe(0);
  });
});

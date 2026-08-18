/**
 * Runs against a real local Postgres — skipped when DATABASE_URL isn't set,
 * same convention as tests/integration/db/multi-tenant-identity.test.ts.
 * Drives src/operator/session.ts's handleTurn end to end (real
 * ConversationRepo/UserRepo, a FakeConsentGate so no consents table row is
 * needed to prove the gating, and a spy chat model) to prove the actual
 * orchestration wiring: an unconsented user's messages never reach the LLM,
 * and a consented one does.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { env } from "../../../src/config/env.js";
import { handleTurn } from "../../../src/operator/session.js";
import { FakeConsentGate } from "../../../src/compliance/consent.fake.js";
import { CONSENT_NOTICE, CONSENT_WELCOME_TEXT } from "../../../src/compliance/consent.js";

class SpyChatModel extends BaseChatModel {
  callCount = 0;

  constructor(fields: BaseChatModelParams = {}) {
    super(fields);
  }

  _llmType(): string {
    return "spy";
  }

  override bindTools(_tools: unknown[]) {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    this.callCount++;
    const message = new AIMessage({ content: "spy-response" });
    return { generations: [{ text: "spy-response", message }] };
  }
}

describe.skipIf(!env.DATABASE_URL)("consent gate (real Postgres, fake consent store + LLM)", () => {
  it("never calls the LLM before consent, and calls it normally after", async () => {
    const model = new SpyChatModel();
    const consentGate = new FakeConsentGate();
    const channel = "telegram";
    const externalId = `test-${randomUUID()}`;

    const firstResponse = await handleTurn(model, { channel, externalId, text: "hi" }, consentGate);
    expect(firstResponse).toBe(CONSENT_NOTICE);
    expect(model.callCount).toBe(0);

    const secondResponse = await handleTurn(model, { channel, externalId, text: "yes" }, consentGate);
    expect(secondResponse).toBe(CONSENT_WELCOME_TEXT);
    expect(model.callCount).toBe(0);

    const thirdResponse = await handleTurn(model, { channel, externalId, text: "what's my claim status?" }, consentGate);
    expect(thirdResponse).toBe("spy-response");
    expect(model.callCount).toBe(1);
  });

  it("re-shows the notice on an ambiguous reply instead of recording consent", async () => {
    const model = new SpyChatModel();
    const consentGate = new FakeConsentGate();
    const channel = "telegram";
    const externalId = `test-${randomUUID()}`;

    await handleTurn(model, { channel, externalId, text: "hi" }, consentGate);
    const response = await handleTurn(model, { channel, externalId, text: "what data do you keep?" }, consentGate);

    expect(response).toBe(CONSENT_NOTICE);
    expect(model.callCount).toBe(0);
    expect(consentGate.consentedUserIds.size).toBe(0);
  });
});

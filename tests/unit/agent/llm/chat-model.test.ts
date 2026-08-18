import { describe, it, expect } from "vitest";
import { createChatModel } from "../../../../src/agent/llm/chat-model.js";
import { FakeChatModel } from "../../../../src/agent/llm/fake-chat-model.js";

describe("createChatModel", () => {
  it("always returns the fake model under NODE_ENV=test, regardless of LLM_PROVIDER", () => {
    const model = createChatModel();
    expect(model).toBeInstanceOf(FakeChatModel);
  });
});

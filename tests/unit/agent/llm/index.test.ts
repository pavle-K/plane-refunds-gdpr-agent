import { describe, it, expect } from "vitest";
import { createLlmClient, FakeLlmClient } from "../../../../src/agent/llm/index.js";

describe("createLlmClient", () => {
  it("always returns the fake client under NODE_ENV=test, regardless of LLM_PROVIDER", () => {
    const client = createLlmClient();
    expect(client).toBeInstanceOf(FakeLlmClient);
  });
});

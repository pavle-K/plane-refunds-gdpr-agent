import { env } from "../../config/env.js";
import type { LlmClient } from "./client.js";
import { AnthropicLlmClient } from "./client.js";
import { FakeLlmClient } from "./fake.js";

export * from "./client.js";
export * from "./structured.js";
export * from "./fake.js";

export function createLlmClient(): LlmClient {
  if (env.NODE_ENV === "test" || !env.ANTHROPIC_API_KEY) {
    return new FakeLlmClient();
  }
  return new AnthropicLlmClient(env.ANTHROPIC_API_KEY);
}

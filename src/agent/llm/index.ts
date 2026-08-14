import { env } from "../../config/env.js";
import type { LlmClient } from "./llm.port.js";
import { AnthropicLlmClient } from "./providers/anthropic.adapter.js";
import { GoogleLlmClient } from "./providers/google.adapter.js";
import { OpenAiCompatibleLlmClient } from "./providers/openai-compatible.adapter.js";
import { FakeLlmClient } from "./fake.adapter.js";
import { DEFAULT_MODELS } from "./model-registry.js";
import { LoggingLlmClient } from "./logging.adapter.js";

export * from "./llm.port.js";
export * from "./structured.js";
export * from "./model-registry.js";
export { FakeLlmClient } from "./fake.adapter.js";
export { AnthropicLlmClient } from "./providers/anthropic.adapter.js";
export { GoogleLlmClient } from "./providers/google.adapter.js";
export { OpenAiCompatibleLlmClient } from "./providers/openai-compatible.adapter.js";
export type { OpenAiCompatibleConfig } from "./providers/openai-compatible.adapter.js";
export { LoggingLlmClient } from "./logging.adapter.js";
export { createTracer, flushTracing, type Tracer, type TurnContext } from "./tracing.adapter.js";
export { getLangfuseClient } from "./langfuse-client.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const XAI_BASE_URL = "https://api.x.ai/v1";

function selectLlmClient(): LlmClient {
  switch (env.LLM_PROVIDER) {
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) return new FakeLlmClient();
      return new AnthropicLlmClient(env.ANTHROPIC_API_KEY, env.LLM_MODEL ?? DEFAULT_MODELS.anthropic);
    }
    case "openai": {
      if (!env.OPENAI_API_KEY) return new FakeLlmClient();
      return new OpenAiCompatibleLlmClient({
        baseUrl: OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
        model: env.LLM_MODEL ?? DEFAULT_MODELS.openai,
      });
    }
    case "xai": {
      if (!env.XAI_API_KEY) return new FakeLlmClient();
      return new OpenAiCompatibleLlmClient({
        baseUrl: XAI_BASE_URL,
        apiKey: env.XAI_API_KEY,
        model: env.LLM_MODEL ?? DEFAULT_MODELS.xai,
      });
    }
    case "google": {
      if (!env.GOOGLE_API_KEY) return new FakeLlmClient();
      return new GoogleLlmClient(env.GOOGLE_API_KEY, env.LLM_MODEL ?? DEFAULT_MODELS.google);
    }
    case "openai-compatible": {
      const model = env.LLM_MODEL ?? env.OPENAI_COMPATIBLE_MODEL;
      if (!env.OPENAI_COMPATIBLE_BASE_URL || !model) return new FakeLlmClient();
      return new OpenAiCompatibleLlmClient({
        baseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
        model,
        ...(env.OPENAI_COMPATIBLE_API_KEY ? { apiKey: env.OPENAI_COMPATIBLE_API_KEY } : {}),
      });
    }
  }
}

/**
 * Picks the live adapter for env.LLM_PROVIDER, falling back to FakeLlmClient
 * whenever the selected provider's required config is missing — same "boots
 * without every key present" convention as every other provider factory (see
 * e.g. src/providers/flight-status/index.ts). Switching providers is
 * LLM_PROVIDER (+ optionally LLM_MODEL) in .env; no code changes.
 *
 * Wraps a REAL provider client with LoggingLlmClient — every provider gets
 * request/response logging at `trace` for free, with no per-adapter code. A
 * FakeLlmClient is returned unwrapped: there's no network round-trip to trace,
 * and several call sites (server.ts's fatal-if-no-key check, every
 * scripts/*.ts entry point's "FAKE vs REAL" message) do `llm instanceof
 * FakeLlmClient` on this factory's return value — wrapping it would silently
 * break every one of them, since the wrapper is a different class.
 */
export function createLlmClient(): LlmClient {
  if (env.NODE_ENV === "test") {
    return new FakeLlmClient();
  }
  const client = selectLlmClient();
  return client instanceof FakeLlmClient ? client : new LoggingLlmClient(client);
}

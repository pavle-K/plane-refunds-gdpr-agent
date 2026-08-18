import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { env } from "../../config/env.js";
import { DEFAULT_MODELS } from "./model-registry.js";
import { FakeChatModel } from "./fake-chat-model.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const XAI_BASE_URL = "https://api.x.ai/v1";

function selectChatModel(): BaseChatModel {
  switch (env.LLM_PROVIDER) {
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) return new FakeChatModel();
      return new ChatAnthropic({ model: env.LLM_MODEL ?? DEFAULT_MODELS.anthropic, apiKey: env.ANTHROPIC_API_KEY });
    }
    case "openai": {
      if (!env.OPENAI_API_KEY) return new FakeChatModel();
      return new ChatOpenAI({
        model: env.LLM_MODEL ?? DEFAULT_MODELS.openai,
        apiKey: env.OPENAI_API_KEY,
        configuration: { baseURL: OPENAI_BASE_URL },
      });
    }
    case "xai": {
      if (!env.XAI_API_KEY) return new FakeChatModel();
      return new ChatOpenAI({
        model: env.LLM_MODEL ?? DEFAULT_MODELS.xai,
        apiKey: env.XAI_API_KEY,
        configuration: { baseURL: XAI_BASE_URL },
      });
    }
    case "google": {
      if (!env.GOOGLE_API_KEY) return new FakeChatModel();
      return new ChatGoogleGenerativeAI({ model: env.LLM_MODEL ?? DEFAULT_MODELS.google, apiKey: env.GOOGLE_API_KEY });
    }
    case "openai-compatible": {
      const model = env.LLM_MODEL ?? env.OPENAI_COMPATIBLE_MODEL;
      if (!env.OPENAI_COMPATIBLE_BASE_URL || !model) return new FakeChatModel();
      return new ChatOpenAI({
        model,
        // Most local runtimes (e.g. Ollama) ignore the key entirely, but the
        // OpenAI SDK under this wrapper still requires a non-empty string to
        // construct — "unused" is a placeholder, never sent anywhere that
        // matters when the target endpoint doesn't check it.
        apiKey: env.OPENAI_COMPATIBLE_API_KEY ?? "unused",
        configuration: { baseURL: env.OPENAI_COMPATIBLE_BASE_URL },
      });
    }
  }
}

/**
 * Picks the live chat model for env.LLM_PROVIDER, falling back to FakeChatModel
 * whenever the selected provider's required config is missing — same
 * "boots without every key present" convention as every other provider
 * factory in this repo. Switching providers is LLM_PROVIDER (+ optionally
 * LLM_MODEL) in .env; no code changes.
 *
 * Unlike the old createLlmClient(), this does not wrap the result in a
 * logging/tracing decorator — LangChain's callback handlers (attached at the
 * createAgent/withStructuredOutput call sites) are the idiomatic place for
 * that, not a wrapper around the model instance itself.
 */
export function createChatModel(): BaseChatModel {
  if (env.NODE_ENV === "test") {
    return new FakeChatModel();
  }
  return selectChatModel();
}

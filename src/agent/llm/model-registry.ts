/** The providers with a first-class env slot (LLM_PROVIDER value + dedicated *_API_KEY). */
export type HostedLlmProviderName = "anthropic" | "openai" | "google" | "xai";

export type LlmProviderName = HostedLlmProviderName | "openai-compatible";

/**
 * Default model id per provider, used when LLM_MODEL isn't set. Provider model
 * catalogs change frequently — verify these against current provider docs before
 * relying on them in production, same caveat as the adapters' "unverified
 * against a live call" notes.
 *
 * "openai-compatible" deliberately has no default here: it's a generic slot for
 * any OpenAI-wire-compatible endpoint (hosted or self-hosted, including every
 * open-weight model), and there's no single sensible default across all of
 * those — OPENAI_COMPATIBLE_MODEL (or LLM_MODEL) is required when it's selected.
 */
export const DEFAULT_MODELS: Record<HostedLlmProviderName, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.1",
  google: "gemini-3-pro",
  xai: "grok-4",
};

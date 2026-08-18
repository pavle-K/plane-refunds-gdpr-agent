/**
 * Thrown when a provider responds with a rate-limit/quota-exceeded status
 * (HTTP 429) — lets a caller (e.g. a channel's message handler) give the user
 * a clear, actionable message ("try again in Ns" / "daily quota exhausted")
 * instead of a generic failure, regardless of which provider is configured.
 *
 * Not yet wired to a real translation layer in src/agent/llm/chat-model.ts —
 * each LangChain provider wrapper (@langchain/anthropic, @langchain/openai,
 * @langchain/google-genai) throws its own error shape on a 429, and mapping
 * each to this class needs verifying against a real rate-limited response per
 * provider before it can be done safely. Known gap, not an oversight: this
 * class and every `instanceof` check against it (src/api/routes/channels/telegram.routes.ts,
 * scripts/chat.ts) are unreachable in production until that translation layer
 * exists.
 */
export class LlmRateLimitedError extends Error {
  constructor(
    public readonly provider: string,
    /** Seconds until the provider says it's safe to retry, when it tells us —
     * not every provider's 429 response includes this. */
    public readonly retryAfterSeconds: number | undefined,
    rawMessage: string,
  ) {
    super(
      `${provider} rate-limited this request` +
        (retryAfterSeconds !== undefined ? ` — retry after ${retryAfterSeconds}s` : "") +
        `: ${rawMessage}`,
    );
    this.name = "LlmRateLimitedError";
  }
}

import type { LlmClient, LlmCompleteParams, LlmCompleteWithToolsParams } from "./llm.port.js";
import { logger, type Logger } from "../../lib/logger.js";

/**
 * Wraps any LlmClient with request/response logging. Not a new provider — a
 * decorator, applied once in createLlmClient() around whichever real adapter
 * env.LLM_PROVIDER selects, so every provider gets this for free instead of
 * each of the three provider adapters (anthropic/google/openai-compatible)
 * duplicating the same logging.
 *
 * `trace` is the raw request/response: system prompt, user prompt, tool names
 * offered, and the model's final text. That is deliberately the most verbose
 * level, not `debug` — `session.ts` already logs every tool call at
 * `info`/`debug` (name, then arguments+result), which answers "what did the
 * operator do" without needing the raw LLM payload; `trace` is for "why did
 * the model decide that", which needs the actual prompt it saw. Kept
 * intentionally separate from Langfuse-style tracing (tracked as later work,
 * not this) — this is a text log, not a queryable trace UI.
 */
export class LoggingLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly log: Logger = logger,
  ) {}

  async complete(params: LlmCompleteParams): Promise<string> {
    const startedAt = Date.now();
    this.log.trace("llm.complete request", { system: params.system, prompt: params.prompt });
    try {
      const result = await this.inner.complete(params);
      this.log.trace("llm.complete response", { result });
      this.log.debug("llm.complete", { durationMs: Date.now() - startedAt });
      return result;
    } catch (cause) {
      this.log.error("llm.complete failed", { durationMs: Date.now() - startedAt, cause: String(cause) });
      throw cause;
    }
  }

  async completeWithTools(params: LlmCompleteWithToolsParams): Promise<string> {
    const startedAt = Date.now();
    this.log.trace("llm.completeWithTools request", {
      system: params.system,
      prompt: params.prompt,
      tools: params.tools.map((t) => t.name),
      historyLength: params.history?.length ?? 0,
    });
    try {
      // onToolCall passed straight through, unwrapped: session.ts already logs
      // every individual tool call at info/debug. Wrapping it again here would
      // double-log the same event under two different call sites.
      const result = await this.inner.completeWithTools(params);
      this.log.trace("llm.completeWithTools response", { result });
      this.log.debug("llm.completeWithTools", { durationMs: Date.now() - startedAt });
      return result;
    } catch (cause) {
      this.log.error("llm.completeWithTools failed", { durationMs: Date.now() - startedAt, cause: String(cause) });
      throw cause;
    }
  }
}

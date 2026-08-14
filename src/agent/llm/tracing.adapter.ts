import { getLangfuseClient } from "./langfuse-client.js";

/**
 * Per-turn tracing. Deliberately NOT an LlmClient decorator like
 * LoggingLlmClient — an agent turn is more than one LLM call wide (a tool loop
 * can round-trip through the model several times) and also contains tool
 * dispatches that never touch the LLM client at all. Langfuse's own hierarchy
 * models that directly: one `trace` per turn, an LLM call is a `generation`
 * inside it, a tool dispatch is a `span` inside it — so the trace has to be
 * created where the turn boundary actually is (session.ts), not at the LLM
 * client layer, which only ever sees one call at a time with no notion of the
 * turn around it.
 *
 * Symmetric to lib/logger.ts's Logger: a no-op implementation when Langfuse
 * isn't configured, so every call site in session.ts stays unconditional
 * (`tracer.generation(...)`, never `tracer?.generation(...)`).
 */
export interface Tracer {
  generation(params: { name: string; model?: string; input: unknown; output: unknown; durationMs: number }): void;
  span(params: { name: string; input: unknown; output: unknown }): void;
  score(params: { name: string; value: number; comment?: string }): void;
  /** The real Langfuse trace id, when tracing is active — undefined for the
   * no-op case. The eval runner uses this to link a dataset item's execution
   * to the exact trace it produced. */
  traceId: string | undefined;
}

const NOOP_TRACER: Tracer = {
  generation: () => {},
  span: () => {},
  score: () => {},
  traceId: undefined,
};

export interface TurnContext {
  name: string;
  userId?: string | undefined;
  sessionId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** One call per turn (handleTurn, resumeConversationAfterEmailConnected) —
 * mirrors logger.child() being created once per turn alongside it. */
export function createTracer(context: TurnContext): Tracer {
  const langfuse = getLangfuseClient();
  if (!langfuse) {
    return NOOP_TRACER;
  }

  const trace = langfuse.trace({
    name: context.name,
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.metadata ? { metadata: context.metadata } : {}),
  });

  return {
    traceId: trace.id,
    generation(params) {
      trace
        .generation({
          name: params.name,
          ...(params.model ? { model: params.model } : {}),
          input: params.input,
        })
        .end({ output: params.output });
      void params.durationMs; // Langfuse derives latency from generation start/end timestamps itself.
    },
    span(params) {
      trace.span({ name: params.name, input: params.input, output: params.output });
    },
    score(params) {
      trace.score({
        name: params.name,
        value: params.value,
        ...(params.comment ? { comment: params.comment } : {}),
      });
    },
  };
}

/** Flushes queued Langfuse events. No-op when unconfigured. Call this before a
 * short-lived process (the eval CLI) exits, and on graceful server shutdown —
 * the SDK batches and flushes on an internal timer, so a process that exits
 * right after tracing a turn can lose that turn's events otherwise. */
export async function flushTracing(): Promise<void> {
  const langfuse = getLangfuseClient();
  if (langfuse) {
    await langfuse.flushAsync();
  }
}

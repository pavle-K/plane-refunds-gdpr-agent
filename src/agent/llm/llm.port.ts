export interface LlmCompleteParams {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** One prior turn of a multi-turn conversation. Plain text only — tool calls/results
 * from earlier turns aren't replayed, only the human-readable exchange, since each
 * turn's tool loop fully resolves before returning (see completeWithTools). */
export interface LlmConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LlmCompleteWithToolsParams {
  system: string;
  prompt: string;
  tools: LlmToolDefinition[];
  /** Runs a requested tool call and returns its result as a string (typically JSON) to feed back to the model. */
  onToolCall: (call: LlmToolCall) => Promise<string>;
  maxTokens?: number;
  /** Safety net against a runaway loop — the model gets a final turn with tools withdrawn if this is hit. */
  maxIterations?: number;
  /** Prior turns of a multi-turn conversation, oldest first. Omit for a single-shot call. */
  history?: LlmConversationTurn[];
}

/**
 * The provider-agnostic contract every LLM adapter implements — see
 * providers/anthropic.adapter.ts, providers/google.adapter.ts, and
 * providers/openai-compatible.adapter.ts. Nothing outside src/agent/llm/ should
 * import a provider SDK directly; swapping providers touches only this folder.
 */
export interface LlmClient {
  complete(params: LlmCompleteParams): Promise<string>;
  /**
   * Runs an agentic tool loop: the model may request tools zero or more times before
   * producing a final text response, which is what this resolves to.
   */
  completeWithTools(params: LlmCompleteWithToolsParams): Promise<string>;
}

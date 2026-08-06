import type { LlmClient, LlmCompleteParams, LlmCompleteWithToolsParams, LlmToolCall } from "./llm.port.js";

type ToolLoopStep = { kind: "tool_call"; call: LlmToolCall } | { kind: "final_text"; text: string };

/** Deterministic, queue-based fake for tests — never calls a real LLM. */
export class FakeLlmClient implements LlmClient {
  private readonly queue: string[] = [];
  private readonly toolLoopQueue: ToolLoopStep[] = [];
  readonly calls: LlmCompleteParams[] = [];
  readonly toolCallsMade: LlmToolCall[] = [];

  enqueueResponse(response: string): void {
    this.queue.push(response);
  }

  enqueueJson(value: unknown): void {
    this.queue.push(JSON.stringify(value));
  }

  /** Scripts the next step of a completeWithTools() loop: a tool call the fake model "requests". */
  enqueueToolCall(call: LlmToolCall): void {
    this.toolLoopQueue.push({ kind: "tool_call", call });
  }

  /** Scripts the final (non-tool-call) response that ends a completeWithTools() loop. */
  enqueueFinalText(text: string): void {
    this.toolLoopQueue.push({ kind: "final_text", text });
  }

  /** Convenience for the common case: enqueue a final JSON response with no tool calls. */
  enqueueFinalJson(value: unknown): void {
    this.enqueueFinalText(JSON.stringify(value));
  }

  async complete(params: LlmCompleteParams): Promise<string> {
    this.calls.push(params);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("FakeLlmClient: no more canned responses queued");
    }
    return next;
  }

  async completeWithTools(params: LlmCompleteWithToolsParams): Promise<string> {
    for (;;) {
      const step = this.toolLoopQueue.shift();
      if (!step) {
        throw new Error("FakeLlmClient: no more tool-loop steps queued");
      }
      if (step.kind === "final_text") {
        return step.text;
      }
      this.toolCallsMade.push(step.call);
      await params.onToolCall(step.call);
    }
  }
}

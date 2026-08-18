import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

export interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

type ScriptedStep = { kind: "tool_calls"; calls: FakeToolCall[] } | { kind: "text"; text: string };

/**
 * Deterministic, queue-based fake `BaseChatModel` — never calls a real LLM.
 * Replaces the old FakeLlmClient (src/agent/llm/fake.adapter.ts, retired in the
 * LangChain convergence) with the same enqueue-based scripting ergonomics, so
 * existing tests only need their construction site changed, not their
 * assertions. Used wherever `createChatModel()` would otherwise return a real
 * provider client — including automatically under NODE_ENV=test.
 */
export class FakeChatModel extends BaseChatModel {
  private readonly queue: ScriptedStep[] = [];
  /** Every messages array this model was invoked with, in order. */
  readonly invocations: BaseMessage[][] = [];
  /** Every tool call this model has "requested", flattened across steps, in order. */
  readonly toolCallsMade: FakeToolCall[] = [];

  static override lc_name(): string {
    return "FakeChatModel";
  }

  constructor(fields: BaseChatModelParams = {}) {
    super(fields);
  }

  _llmType(): string {
    return "fake";
  }

  /** Scripts the model's next turn as one or more tool calls (parallel calls: pass several). */
  enqueueToolCall(...calls: FakeToolCall[]): void {
    this.queue.push({ kind: "tool_calls", calls });
  }

  /** Scripts the model's next turn as a plain text response — ends a tool-calling loop. */
  enqueueFinalText(text: string): void {
    this.queue.push({ kind: "text", text });
  }

  /** Convenience for the common case: a final JSON response with no tool calls. */
  enqueueFinalJson(value: unknown): void {
    this.enqueueFinalText(JSON.stringify(value));
  }

  /**
   * No-op tool binding: this fake's output is fully scripted via the enqueue
   * methods above and never actually inspects the bound tool schemas to decide
   * anything, unlike a real provider. Implemented (rather than left undefined)
   * because createAgent requires `typeof model.bindTools === "function"`
   * whenever it's given tools.
   */
  override bindTools(_tools: unknown[]) {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.invocations.push(messages);
    const step = this.queue.shift();
    if (!step) {
      throw new Error("FakeChatModel: no more scripted responses queued");
    }

    if (step.kind === "text") {
      const message = new AIMessage({ content: step.text });
      return { generations: [{ text: step.text, message }] };
    }

    this.toolCallsMade.push(...step.calls);
    const message = new AIMessage({
      content: "",
      tool_calls: step.calls.map((call, i) => ({ name: call.name, args: call.args, id: `fake-call-${i}` })),
    });
    return { generations: [{ text: "", message }] };
  }
}

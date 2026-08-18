import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, SystemMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";
import type { Runnable } from "@langchain/core/runnables";

export interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FakeStructuredCall {
  system: string;
  prompt: string;
}

type ScriptedStep =
  | { kind: "tool_calls"; calls: FakeToolCall[] }
  | { kind: "text"; text: string }
  | { kind: "structured_tool_call"; args: Record<string, unknown> };

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
  /** Every withStructuredOutput() call this model received, in order — the
   * callStructured(model, {system, prompt, schema}) equivalent of `invocations`
   * for the tool-calling path (src/agent/llm/structured.ts always calls with
   * exactly a SystemMessage then a HumanMessage, so both are recoverable here). */
  readonly calls: FakeStructuredCall[] = [];
  /** Tool names bound just before the most recent _generate() call — used to
   * resolve enqueueStructuredToolCall's target (see that method's doc comment). */
  private lastBoundToolNames: string[] = [];

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
   * Scripts the next turn as a call to createAgent's `responseFormat` tool —
   * the mechanism createAgent uses (verified empirically, not documented) to
   * get a structured final response: it binds a synthetic tool named
   * `extract-N` and expects the model to call it with the response-format
   * schema's shape as args. N increments on every bindTools() call — one per
   * model-call iteration in the loop — so it is NOT stable across a turn with
   * any real tool calls before it (extract-1 on a zero-tool-call turn,
   * extract-2 if one real tool was called first, etc). Hardcoding a guessed
   * number here would silently stop matching the moment a test's tool-call
   * count changes, so this resolves the actual current name from the tools
   * most recently bound, right before this step runs.
   */
  enqueueStructuredToolCall(args: Record<string, unknown>): void {
    this.queue.push({ kind: "structured_tool_call", args });
  }

  /**
   * Records which tool names createAgent bound for the upcoming _generate()
   * call — this fake's output is otherwise fully scripted via the enqueue
   * methods above and never inspects the bound schemas to decide behavior,
   * unlike a real provider. bindTools itself must exist (not be left
   * undefined) because createAgent requires `typeof model.bindTools ===
   * "function"` whenever it's given tools.
   */
  override bindTools(tools: unknown[]) {
    this.lastBoundToolNames = tools.map((t) => {
      const withFunction = t as { function?: { name?: string } };
      const withName = t as { name?: string };
      return withFunction.function?.name ?? withName.name ?? "";
    });
    return this;
  }

  /**
   * Reuses the SAME scripted queue as the tool-calling path (enqueueFinalText/
   * enqueueFinalJson) — a structured call is just "the final step of a loop",
   * so the same enqueue vocabulary scripts both. Runs the given schema's
   * .parse() on the scripted JSON when it looks like a zod schema, same
   * validate-and-throw contract real withStructuredOutput has, so a test that
   * scripts a shape not matching what the node asked for fails loudly.
   */
  override withStructuredOutput<RunOutput extends Record<string, unknown> = Record<string, unknown>>(
    outputSchema: unknown,
  ): Runnable<unknown, RunOutput> {
    return RunnableLambda.from(async (input: unknown) => {
      if (Array.isArray(input) && input.length === 2 && SystemMessage.isInstance(input[0]) && HumanMessage.isInstance(input[1])) {
        this.calls.push({ system: String(input[0].content), prompt: String(input[1].content) });
      }
      const step = this.queue.shift();
      if (!step) {
        throw new Error("FakeChatModel: no more scripted responses queued");
      }
      if (step.kind !== "text") {
        throw new Error(
          "FakeChatModel.withStructuredOutput: a tool-call step was scripted, but structured-output calls " +
            "on this fake don't support a tool loop — script enqueueFinalText/enqueueFinalJson instead.",
        );
      }
      const parsed: unknown = JSON.parse(step.text);
      const schema = outputSchema as { parse?: (value: unknown) => RunOutput };
      return typeof schema.parse === "function" ? schema.parse(parsed) : (parsed as RunOutput);
    });
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

    if (step.kind === "structured_tool_call") {
      const extractToolName = this.lastBoundToolNames.find((name) => /^extract-\d+$/.test(name));
      if (!extractToolName) {
        throw new Error(
          "FakeChatModel: enqueueStructuredToolCall was scripted, but no createAgent responseFormat tool " +
            `(matching /^extract-\\d+$/) was bound for this turn — bound tools were: [${this.lastBoundToolNames.join(", ")}]`,
        );
      }
      const call: FakeToolCall = { name: extractToolName, args: step.args };
      this.toolCallsMade.push(call);
      const message = new AIMessage({ content: "", tool_calls: [{ name: call.name, args: call.args, id: "fake-call-0" }] });
      return { generations: [{ text: "", message }] };
    }

    this.toolCallsMade.push(...step.calls);
    const message = new AIMessage({
      content: "",
      tool_calls: step.calls.map((call, i) => ({ name: call.name, args: call.args, id: `fake-call-${i}` })),
    });
    return { generations: [{ text: "", message }] };
  }
}

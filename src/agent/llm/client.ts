import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOOL_ITERATIONS = 8;

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

export interface LlmCompleteWithToolsParams {
  system: string;
  prompt: string;
  tools: LlmToolDefinition[];
  /** Runs a requested tool call and returns its result as a string (typically JSON) to feed back to the model. */
  onToolCall: (call: LlmToolCall) => Promise<string>;
  maxTokens?: number;
  /** Safety net against a runaway loop — the model gets a final turn with tools withdrawn if this is hit. */
  maxIterations?: number;
}

export interface LlmClient {
  complete(params: LlmCompleteParams): Promise<string>;
  /**
   * Runs an agentic tool loop: the model may request tools zero or more times before
   * producing a final text response, which is what this resolves to.
   */
  completeWithTools(params: LlmCompleteWithToolsParams): Promise<string>;
}

/** Thin wrapper around the Anthropic SDK — unverified against a live call (no
 * ANTHROPIC_API_KEY set yet). The shape of the SDK call itself is standard and
 * stable, so this is lower-risk than the AeroAPI adapter, but confirm once a key
 * is available. */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete({ system, prompt, maxTokens = 2048 }: LlmCompleteParams): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Anthropic response contained no text block");
    }
    return textBlock.text;
  }

  async completeWithTools({
    system,
    prompt,
    tools,
    onToolCall,
    maxTokens = 2048,
    maxIterations = DEFAULT_MAX_TOOL_ITERATIONS,
  }: LlmCompleteWithToolsParams): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system,
        tools: anthropicTools,
        messages,
      });
      messages.push({ role: "assistant", content: response.content });

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      if (toolUseBlocks.length === 0) {
        const textBlock = response.content.find((block) => block.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          throw new Error(
            `Anthropic response contained no text block and no tool call (stop_reason: ${response.stop_reason})`,
          );
        }
        return textBlock.text;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const resultText = await onToolCall({ name: toolUse.name, input: toolUse.input as Record<string, unknown> });
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: resultText });
      }
      messages.push({ role: "user", content: toolResults });
    }

    throw new Error(`LLM tool loop did not converge within ${maxIterations} iterations`);
  }
}

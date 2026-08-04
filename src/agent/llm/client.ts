import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-5";

export interface LlmCompleteParams {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface LlmClient {
  complete(params: LlmCompleteParams): Promise<string>;
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
}

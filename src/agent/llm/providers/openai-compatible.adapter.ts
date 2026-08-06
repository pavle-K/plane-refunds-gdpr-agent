import type { LlmClient, LlmCompleteParams, LlmCompleteWithToolsParams } from "../llm.port.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 8;

export interface OpenAiCompatibleConfig {
  /** e.g. https://api.openai.com/v1, https://api.x.ai/v1, http://localhost:11434/v1 (Ollama) */
  baseUrl: string;
  /** Omit for servers that don't check it (most local runtimes, e.g. Ollama). */
  apiKey?: string;
  model: string;
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{ message?: { content: string | null; tool_calls?: OpenAiToolCall[] } }>;
}

/**
 * Talks to any provider implementing OpenAI's Chat Completions wire format —
 * OpenAI itself, xAI (Grok), and every hosted or self-hosted open-weight model
 * server that exposes the same API (Ollama, vLLM, LM Studio, OpenRouter,
 * Together, Groq, DeepSeek's own API, ...). One adapter covers all of them; only
 * baseUrl/apiKey/model differ between them. Unverified against a live call for
 * any of these endpoints — the wire format is standard and stable, but confirm
 * once a key or local server is available, same caveat as the Anthropic adapter.
 */
export class OpenAiCompatibleLlmClient implements LlmClient {
  constructor(private readonly config: OpenAiCompatibleConfig) {}

  private async chatCompletion(body: Record<string, unknown>): Promise<{
    content: string | null;
    toolCalls: OpenAiToolCall[] | undefined;
  }> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.config.model, ...body }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible endpoint (${url}) returned ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as OpenAiChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new Error("OpenAI-compatible response contained no choices[0].message");
    }
    return { content: message.content ?? null, toolCalls: message.tool_calls };
  }

  async complete({ system, prompt, maxTokens = 2048 }: LlmCompleteParams): Promise<string> {
    const { content } = await this.chatCompletion({
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
    });
    if (content === null) {
      throw new Error("OpenAI-compatible response contained no text content");
    }
    return content;
  }

  async completeWithTools({
    system,
    prompt,
    tools,
    onToolCall,
    maxTokens = 2048,
    maxIterations = DEFAULT_MAX_TOOL_ITERATIONS,
    history = [],
  }: LlmCompleteWithToolsParams): Promise<string> {
    const messages: OpenAiMessage[] = [
      { role: "system", content: system },
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user", content: prompt },
    ];
    const openAiTools = tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const { content, toolCalls } = await this.chatCompletion({
        messages,
        tools: openAiTools,
        max_tokens: maxTokens,
      });
      messages.push({ role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) });

      if (!toolCalls || toolCalls.length === 0) {
        if (content === null) {
          throw new Error("OpenAI-compatible response contained no text content and no tool call");
        }
        return content;
      }

      for (const call of toolCalls) {
        const resultText = await onToolCall({
          name: call.function.name,
          input: JSON.parse(call.function.arguments) as Record<string, unknown>,
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
      }
    }

    throw new Error(`LLM tool loop did not converge within ${maxIterations} iterations`);
  }
}

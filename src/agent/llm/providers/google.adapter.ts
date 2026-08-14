import { LlmRateLimitedError, type LlmClient, type LlmCompleteParams, type LlmCompleteWithToolsParams } from "../llm.port.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 8;
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiErrorBody {
  error?: {
    message?: string;
    details?: Array<{ "@type"?: string; retryDelay?: string }>;
  };
}

/** Gemini's RetryInfo detail carries a duration like "37.552280594s" —
 * protobuf's Duration text format, not a plain number. Returns undefined
 * rather than throwing if the shape doesn't match; a missing retry hint just
 * means LlmRateLimitedError.retryAfterSeconds stays undefined. */
function parseGeminiRetryDelaySeconds(body: GeminiErrorBody): number | undefined {
  const retryDelay = body.error?.details?.find((d) => d.retryDelay)?.retryDelay;
  if (!retryDelay) {
    return undefined;
  }
  const seconds = Number.parseFloat(retryDelay.replace(/s$/, ""));
  return Number.isFinite(seconds) ? seconds : undefined;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: string } };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
}

/**
 * Talks to the Gemini API directly over REST rather than adding the @google/genai
 * SDK as a dependency — consistent with how outlook.adapter.ts talks to Microsoft
 * Graph in this codebase. Tool results are sent back as role "user" (not a
 * separate "function" role — Gemini has no such role; confirmed against a live
 * 400 response listing the actual valid roles, which don't include it).
 */
export class GoogleLlmClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  private async generateContent(body: Record<string, unknown>): Promise<GeminiPart[]> {
    const url = `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const rawText = await response.text();
      if (response.status === 429) {
        let retryAfterSeconds: number | undefined;
        try {
          retryAfterSeconds = parseGeminiRetryDelaySeconds(JSON.parse(rawText) as GeminiErrorBody);
        } catch {
          // Malformed/non-JSON error body — still a rate limit, just without a retry hint.
        }
        throw new LlmRateLimitedError("Gemini", retryAfterSeconds, rawText);
      }
      throw new Error(`Gemini API returned ${response.status}: ${rawText}`);
    }

    const data = (await response.json()) as GeminiGenerateContentResponse;
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) {
      throw new Error("Gemini response contained no candidates[0].content.parts");
    }
    return parts;
  }

  async complete({ system, prompt, maxTokens = 2048 }: LlmCompleteParams): Promise<string> {
    const parts = await this.generateContent({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    });
    const text = parts.find((p) => p.text !== undefined)?.text;
    if (text === undefined) {
      throw new Error("Gemini response contained no text part");
    }
    return text;
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
    const contents: GeminiContent[] = [
      ...history.map((turn) => ({
        role: (turn.role === "assistant" ? "model" : "user") as "user" | "model",
        parts: [{ text: turn.content }],
      })),
      { role: "user", parts: [{ text: prompt }] },
    ];
    const functionDeclarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const parts = await this.generateContent({
        system_instruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations }],
        generationConfig: { maxOutputTokens: maxTokens },
      });
      contents.push({ role: "model", parts });

      const functionCallParts = parts.filter((p) => p.functionCall !== undefined);
      if (functionCallParts.length === 0) {
        const text = parts.find((p) => p.text !== undefined)?.text;
        if (text === undefined) {
          throw new Error("Gemini response contained no text part and no function call");
        }
        return text;
      }

      const responseParts: GeminiPart[] = [];
      for (const part of functionCallParts) {
        const call = part.functionCall!;
        const resultText = await onToolCall({ name: call.name, input: call.args });
        responseParts.push({ functionResponse: { name: call.name, response: { result: resultText } } });
      }
      contents.push({ role: "user", parts: responseParts });
    }

    throw new Error(`LLM tool loop did not converge within ${maxIterations} iterations`);
  }
}

import type { z } from "zod";
import type { LlmClient, LlmToolDefinition, LlmToolCall } from "./llm.port.js";

export class StructuredLlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredLlmOutputError";
  }
}

export interface StructuredCallParams<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface StructuredCallWithToolsParams<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  tools: LlmToolDefinition[];
  onToolCall: (call: LlmToolCall) => Promise<string>;
  maxTokens?: number;
  maxIterations?: number;
}

const JSON_ONLY_INSTRUCTION =
  "\n\nRespond with ONLY valid JSON matching the required schema. No prose, no markdown code fences.";

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

function parseAndValidate<T>(raw: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (cause) {
    throw new StructuredLlmOutputError(`LLM did not return valid JSON: ${String(cause)}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StructuredLlmOutputError(`LLM output failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Calls the LLM and validates its output against a zod schema before returning.
 * Never returns unvalidated data — an invalid or malformed response throws
 * StructuredLlmOutputError rather than silently passing through partial JSON.
 */
export async function callStructured<T>(
  client: LlmClient,
  params: StructuredCallParams<T>,
): Promise<T> {
  const raw = await client.complete({
    system: params.system + JSON_ONLY_INSTRUCTION,
    prompt: params.prompt,
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
  });
  return parseAndValidate(raw, params.schema);
}

/**
 * Same contract as callStructured, but runs an agentic tool loop first — the model
 * may call tools (e.g. to fetch an email attachment's text) before producing the
 * final JSON. Only the final, non-tool-call response is parsed and validated.
 */
export async function callStructuredWithTools<T>(
  client: LlmClient,
  params: StructuredCallWithToolsParams<T>,
): Promise<T> {
  const raw = await client.completeWithTools({
    system: params.system + JSON_ONLY_INSTRUCTION,
    prompt: params.prompt,
    tools: params.tools,
    onToolCall: params.onToolCall,
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    ...(params.maxIterations !== undefined ? { maxIterations: params.maxIterations } : {}),
  });
  return parseAndValidate(raw, params.schema);
}

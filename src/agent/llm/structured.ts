import type { z } from "zod";
import type { LlmClient } from "./client.js";

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

const JSON_ONLY_INSTRUCTION =
  "\n\nRespond with ONLY valid JSON matching the required schema. No prose, no markdown code fences.";

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (cause) {
    throw new StructuredLlmOutputError(`LLM did not return valid JSON: ${String(cause)}`);
  }

  const result = params.schema.safeParse(parsed);
  if (!result.success) {
    throw new StructuredLlmOutputError(`LLM output failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

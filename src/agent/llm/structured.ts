import type { z } from "zod";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface StructuredCallParams<T extends Record<string, unknown>> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

/**
 * Calls the LLM and returns output already validated against a zod schema —
 * uses the provider's native structured-output/forced-function-calling mode
 * (BaseChatModel.withStructuredOutput), not a hand-rolled "ask nicely for
 * JSON, strip markdown fences, JSON.parse, then validate" prompt hack. Throws
 * (StructuredOutputParsingError, from `langchain`) on a response that doesn't
 * match the schema — never returns unvalidated data.
 */
export async function callStructured<T extends Record<string, unknown>>(
  model: BaseChatModel,
  params: StructuredCallParams<T>,
): Promise<T> {
  return (await model
    .withStructuredOutput(params.schema)
    .invoke([new SystemMessage(params.system), new HumanMessage(params.prompt)])) as T;
}

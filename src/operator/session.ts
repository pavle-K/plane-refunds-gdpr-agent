import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LlmClient } from "../agent/llm/llm.port.js";
import { ConversationRepo } from "../db/repositories/conversation.repo.js";
import { TOOL_DEFINITIONS, OperatorTools } from "./tools.js";

const BASE_SYSTEM_PROMPT = readFileSync(fileURLToPath(new URL("./prompt.md", import.meta.url)), "utf-8");

/**
 * The model has no other way to know today's date — without this it falls back to
 * guessing from training data, which silently resolves things like "check March"
 * to the wrong year. Computed fresh per call (not baked in once) so a
 * long-running session stays correct if it crosses midnight.
 */
function buildSystemPrompt(): string {
  const now = new Date();
  return `${BASE_SYSTEM_PROMPT}\n\n## Current date and time\n\nRight now it is ${now.toISOString()} (UTC) — today's date is ${now.toISOString().slice(0, 10)}. Always resolve dates the user gives you (a bare month name, "last week", "this year", a relative range) against THIS date, never against your training data or an assumed year.`;
}

/**
 * OperatorTools tracks "the last claim thread touched" as in-memory instance
 * state (a chat convenience — "approve it" without repeating a threadId). That
 * has to stay scoped per conversation, not shared globally, once multiple
 * channels/users hit this process concurrently — hence one instance per
 * channel identity, kept for the life of the process.
 */
const operatorToolsByIdentity = new Map<string, OperatorTools>();

function getOperatorTools(channelIdentityId: string): OperatorTools {
  let tools = operatorToolsByIdentity.get(channelIdentityId);
  if (!tools) {
    tools = new OperatorTools();
    operatorToolsByIdentity.set(channelIdentityId, tools);
  }
  return tools;
}

export interface IncomingTurn {
  channel: string;
  externalId: string;
  text: string;
  /** Optional visibility hook for callers that want to surface tool activity
   * (e.g. the CLI printing "[start_claim(...)]" as it happens). No-op if omitted. */
  onToolCall?: (call: { name: string; input: Record<string, unknown> }) => void;
}

/**
 * The one piece of conversation logic every entry point shares — CLI
 * (scripts/chat.ts) and every messaging channel webhook alike. Loads that
 * identity's persisted history, runs the same tool-use loop the CLI always
 * has, and persists the new turn. Nothing channel-specific lives here; a
 * channel adapter's only job is turning its platform's payload into
 * {channel, externalId, text} and sending the returned string back out.
 */
export async function handleTurn(llm: LlmClient, turn: IncomingTurn): Promise<string> {
  const repo = new ConversationRepo();
  const channelIdentityId = await repo.getOrCreateIdentity(turn.channel, turn.externalId);
  const history = await repo.loadHistory(channelIdentityId);
  const tools = getOperatorTools(channelIdentityId);

  const responseText = await llm.completeWithTools({
    system: buildSystemPrompt(),
    prompt: turn.text,
    tools: TOOL_DEFINITIONS,
    history,
    onToolCall: async (call) => {
      turn.onToolCall?.(call);
      try {
        const result = await tools.dispatch(call.name, call.input);
        return JSON.stringify(result);
      } catch (cause) {
        return JSON.stringify({ error: String(cause) });
      }
    },
  });

  await repo.appendTurn(channelIdentityId, "user", turn.text);
  await repo.appendTurn(channelIdentityId, "assistant", responseText);

  return responseText;
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LlmClient, LlmConversationTurn } from "../agent/llm/llm.port.js";
import { ConversationRepo } from "../db/repositories/conversation.repo.js";
import { UserRepo } from "../db/repositories/user.repo.js";
import { type ConsentGate, DbConsentGate, decideConsent, CONSENT_NOTICE } from "../compliance/consent.js";
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

/** Shared by handleTurn and resumeConversationAfterEmailConnected — runs one
 * completeWithTools turn against the given tools instance, wiring the
 * dispatch/JSON-stringify/error-catch plumbing once instead of twice. */
async function runLlmTurn(
  llm: LlmClient,
  params: {
    prompt: string;
    history: LlmConversationTurn[];
    tools: OperatorTools;
    onToolCall?: (call: { name: string; input: Record<string, unknown> }) => void;
  },
): Promise<string> {
  return llm.completeWithTools({
    system: buildSystemPrompt(),
    prompt: params.prompt,
    tools: TOOL_DEFINITIONS,
    history: params.history,
    onToolCall: async (call) => {
      params.onToolCall?.(call);
      try {
        const result = await params.tools.dispatch(call.name, call.input);
        return JSON.stringify(result);
      } catch (cause) {
        return JSON.stringify({ error: String(cause) });
      }
    },
  });
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
 *
 * Gates on consent before any of that: an unconsented user's message never
 * reaches the LLM or a tool — see src/compliance/consent.ts's decideConsent,
 * which is where the actual decision logic (and its tests) live.
 *
 * Constructs a fresh OperatorTools every turn rather than caching one per
 * identity — it holds no per-conversation state of its own (see its own doc
 * comment), so there's nothing to gain from reusing an instance, and caching
 * one per process would break the moment this runs as more than one
 * horizontally-scaled instance, since a later turn from the same identity
 * could land on a different process. All the state that needs to survive
 * across turns already lives in Postgres.
 */
export async function handleTurn(
  llm: LlmClient,
  turn: IncomingTurn,
  consentGate: ConsentGate = new DbConsentGate(),
): Promise<string> {
  const repo = new ConversationRepo();
  const channelIdentityId = await repo.getOrCreateIdentity(turn.channel, turn.externalId);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) {
    // getOrCreateIdentity always links a user to every channel identity it
    // creates/returns — this would only happen if the DB was hand-edited.
    throw new Error(`Channel identity ${channelIdentityId} has no linked user.`);
  }

  const alreadyConsented = await consentGate.hasConsented(userId);
  const history = await repo.loadHistory(channelIdentityId);
  // Whether *this notice* was already shown, not merely "has this identity
  // ever spoken" — an identity that talked to this bot before the consent
  // system existed has history but has never seen it either. See
  // decideConsent's doc comment.
  const noticeAlreadyShown = history.some((h) => h.role === "assistant" && h.content === CONSENT_NOTICE);
  const consentDecision = decideConsent({
    alreadyConsented,
    noticeAlreadyShown,
    messageText: turn.text,
  });

  if (consentDecision.action !== "proceed") {
    if (consentDecision.action === "consent_recorded") {
      await consentGate.recordConsent(userId, turn.channel);
    }
    await repo.appendTurn(channelIdentityId, "user", turn.text);
    await repo.appendTurn(channelIdentityId, "assistant", consentDecision.responseText);
    return consentDecision.responseText;
  }

  const tools = new OperatorTools(userId, channelIdentityId);
  const responseText = await runLlmTurn(llm, {
    prompt: turn.text,
    history,
    tools,
    ...(turn.onToolCall ? { onToolCall: turn.onToolCall } : {}),
  });

  await repo.appendTurn(channelIdentityId, "user", turn.text);
  await repo.appendTurn(channelIdentityId, "assistant", responseText);

  return responseText;
}

function buildEmailConnectedNote(emailAddress: string): string {
  return (
    `[Automated system note — not sent by the user: their email account (${emailAddress}) just finished ` +
    "connecting via the authorization link you sent earlier. If their most recent request needed a connected " +
    "inbox (e.g. scanning it), go ahead and do that now using the available tools and report the result — " +
    "don't just confirm the connection and wait to be asked again. If nothing they asked for needed this " +
    "connection, just briefly confirm it's done."
  );
}

/**
 * Called from the OAuth callback route (src/api/routes/oauth.routes.ts) once
 * a hosted email connection actually completes — not from a real inbound
 * message, so it skips handleTurn's consent gate entirely (only reachable
 * after a user has already consented and asked to connect an account).
 *
 * Rather than just announcing "connected" and stopping there, this feeds the
 * LLM the real conversation history plus a note that the connection just
 * completed, with full tool access — so if the user's last request needed
 * this connection (e.g. "analyze my emails"), it gets carried out and
 * reported immediately instead of requiring the user to ask again. Callers
 * should fall back to a fixed confirmation if this throws (e.g. the LLM call
 * fails) — never let a broken resumption mean no confirmation arrives at all.
 */
export async function resumeConversationAfterEmailConnected(
  llm: LlmClient,
  params: { channelIdentityId: string; userId: string; emailAddress: string },
): Promise<string> {
  const repo = new ConversationRepo();
  const history = await repo.loadHistory(params.channelIdentityId);
  const tools = new OperatorTools(params.userId, params.channelIdentityId);
  const note = buildEmailConnectedNote(params.emailAddress);

  const responseText = await runLlmTurn(llm, { prompt: note, history, tools });

  await repo.appendTurn(params.channelIdentityId, "user", note);
  await repo.appendTurn(params.channelIdentityId, "assistant", responseText);

  return responseText;
}

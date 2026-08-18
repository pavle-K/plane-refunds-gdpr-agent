import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createAgent, contextEditingMiddleware, ClearToolUsesEdit } from "langchain";
import { HumanMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getCheckpointer } from "../agent/checkpointer.js";
import { ConversationRepo } from "../db/repositories/conversation.repo.js";
import { UserRepo } from "../db/repositories/user.repo.js";
import { PendingConfirmationRepo } from "../db/repositories/pending-confirmation.repo.js";
import { type ConsentGate, DbConsentGate, decideConsent, isAffirmativeReply } from "../compliance/consent.js";
import { buildOperatorTools, OperatorTools, describeConfirmedActionResult, operatorThreadId } from "./tools.js";
import { logger, type Logger } from "../lib/logger.js";
import { createTracer, type Tracer } from "../agent/llm/tracing.adapter.js";
import { env } from "../config/env.js";

/**
 * Bounds how much of a thread's history gets sent to the model per turn —
 * the LangGraph checkpointer thread otherwise grows unboundedly across a
 * long-running conversation, the same problem env.MAX_HISTORY_TOKENS was
 * originally introduced to solve (see that var's doc comment: a real
 * conversation replayed 40 full turns, including a drafted claim letter, on
 * every single request). Clears old tool-call payloads once the trigger is
 * hit rather than dropping whole messages outright — a naive "drop the
 * oldest messages" trim risks leaving a dangling ToolMessage with no
 * matching preceding AIMessage.tool_calls, which providers reject as an
 * invalid message sequence; ClearToolUsesEdit is LangChain's own maintained
 * answer to that, not something worth re-deriving by hand.
 */
const historyMiddleware = contextEditingMiddleware({
  edits: [new ClearToolUsesEdit({ trigger: { tokens: env.MAX_HISTORY_TOKENS }, keep: { messages: 5 } })],
});

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
 * Runs one turn of the operator's conversational agent (createAgent, from
 * `langchain`) against the given channel identity's own thread on the
 * shared LangGraph checkpointer — the agent's reasoning memory now lives
 * there, continued automatically across turns, rather than being manually
 * reloaded/truncated/re-passed the way the pre-LangChain hand-rolled tool
 * loop did.
 *
 * Every tool call is logged and traced inside buildOperatorTools itself
 * (src/operator/tools.ts) — this function's own job is just the turn-level
 * concerns: building the agent, invoking it, and recording the LLM call as a
 * single Langfuse generation (mirroring the old runLlmTurn's shape).
 *
 * "New" messages for this turn (used for onToolCall visibility and the
 * turn's tool-call count) are everything after the most recent HumanMessage
 * in the returned thread — that's provably the message this call just sent,
 * since nothing else in a single turn injects a synthetic Human message.
 */
async function runAgentTurn(
  model: BaseChatModel,
  params: {
    prompt: string;
    threadId: string;
    tools: OperatorTools;
    log: Logger;
    tracer: Tracer;
    onToolCall?: (call: { name: string; input: Record<string, unknown> }) => void;
  },
): Promise<{ responseText: string; toolCallCount: number }> {
  const startedAt = Date.now();
  const system = buildSystemPrompt();

  const agent = createAgent({
    model,
    tools: buildOperatorTools(params.tools, params.log, params.tracer),
    systemPrompt: system,
    checkpointer: getCheckpointer(),
    middleware: [historyMiddleware],
  });

  const result = await agent.invoke(
    { messages: [new HumanMessage(params.prompt)] },
    { configurable: { thread_id: params.threadId } },
  );

  const messages = result.messages as BaseMessage[];
  let lastHumanIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (HumanMessage.isInstance(messages[i])) {
      lastHumanIndex = i;
      break;
    }
  }
  const turnMessages = lastHumanIndex >= 0 ? messages.slice(lastHumanIndex + 1) : [];

  let toolCallCount = 0;
  for (const message of turnMessages) {
    if (AIMessage.isInstance(message) && message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        toolCallCount += 1;
        params.onToolCall?.({ name: call.name, input: call.args });
      }
    }
  }

  const finalMessage = messages[messages.length - 1];
  const responseText = typeof finalMessage?.content === "string" ? finalMessage.content : "";

  params.tracer.generation({
    name: "operator.completeWithTools",
    input: { system, prompt: params.prompt },
    output: responseText,
    durationMs: Date.now() - startedAt,
  });

  return { responseText, toolCallCount };
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
 * (scripts/chat.ts) and every messaging channel webhook alike. Runs the
 * operator agent against this identity's own checkpointer thread, and
 * separately appends the turn to conversation_messages
 * (ConversationRepo) — a compliance/audit transcript, NOT what's fed to the
 * model (the checkpointer thread is), kept because it's the one place every
 * turn is recorded unconditionally, including turns the agent never even
 * runs on (consent-gated, pending-confirmation-gated).
 *
 * Gates on consent before any of that: an unconsented user's message never
 * reaches the agent — see src/compliance/consent.ts's decideConsent, which is
 * where the actual decision logic (and its tests) live.
 *
 * Constructs a fresh OperatorTools every turn rather than caching one per
 * identity — it holds no per-conversation state of its own (see its own doc
 * comment), so there's nothing to gain from reusing an instance, and caching
 * one per process would break the moment this runs as more than one
 * horizontally-scaled instance, since a later turn from the same identity
 * could land on a different process. All the state that needs to survive
 * across turns already lives in Postgres (either the checkpointer, for the
 * agent's own memory, or conversation_messages, for the transcript).
 */
export async function handleTurn(
  model: BaseChatModel,
  turn: IncomingTurn,
  consentGate: ConsentGate = new DbConsentGate(),
): Promise<string> {
  // One id per turn, threaded through every log line this turn produces —
  // the only way to pick one turn's lines out of a busy stream when several
  // users are chatting concurrently.
  const turnId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  let log = logger.child({ turnId, channel: turn.channel, externalId: turn.externalId });
  log.info("turn received", { textLength: turn.text.length });

  const repo = new ConversationRepo();
  const channelIdentityId = await repo.getOrCreateIdentity(turn.channel, turn.externalId);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) {
    // getOrCreateIdentity always links a user to every channel identity it
    // creates/returns — this would only happen if the DB was hand-edited.
    throw new Error(`Channel identity ${channelIdentityId} has no linked user.`);
  }
  log = log.child({ userId });

  const alreadyConsented = await consentGate.hasConsented(userId);
  // channel_identities.noticeShownAtUtc, not a history scan — see that
  // column's doc comment (schema.ts) for why: the agent's checkpointer
  // thread is its own reasoning memory, not a general compliance transcript,
  // and a consent-gated turn never invokes the agent at all, so there would
  // be nothing in it to scan.
  const noticeAlreadyShown = await repo.wasNoticeShown(channelIdentityId);
  const consentDecision = decideConsent({
    alreadyConsented,
    noticeAlreadyShown,
    messageText: turn.text,
  });

  if (consentDecision.action !== "proceed") {
    log.info("consent gate blocked turn", { action: consentDecision.action });
    if (consentDecision.action === "consent_recorded") {
      await consentGate.recordConsent(userId, turn.channel);
    }
    if (consentDecision.action === "show_notice") {
      await repo.markNoticeShown(channelIdentityId);
    }
    await repo.appendTurn(channelIdentityId, "user", turn.text);
    await repo.appendTurn(channelIdentityId, "assistant", consentDecision.responseText);
    return consentDecision.responseText;
  }

  // Deterministic confirmation gate for irreversible actions (forget_my_data,
  // disconnect_email) — same rigor and same reason as the consent gate above:
  // an LLM can hallucinate having completed an irreversible action without
  // ever calling its tool, so whether one of these actually executes is
  // decided here, by code matching an explicit "yes" against a pending
  // request, never by anything the LLM itself generates. See
  // src/db/repositories/pending-confirmation.repo.ts.
  //
  // Logged unconditionally, including the "no pending confirmation" case —
  // that absence is exactly what proves a prior turn never actually called
  // forget_my_data/disconnect_email in the first place, rather than the model
  // having correctly started the flow and this turn just being the confirm.
  const pendingConfirmationRepo = new PendingConfirmationRepo();
  const pendingConfirmation = await pendingConfirmationRepo.findActiveForUser(userId);
  log.info("pending confirmation checked", {
    found: Boolean(pendingConfirmation),
    ...(pendingConfirmation ? { actionType: pendingConfirmation.actionType } : {}),
  });
  if (pendingConfirmation) {
    await pendingConfirmationRepo.resolve(pendingConfirmation.id);
    const affirmative = isAffirmativeReply(turn.text);
    log.info("pending confirmation resolved", { actionType: pendingConfirmation.actionType, affirmative });

    const responseText = affirmative
      ? describeConfirmedActionResult(
          pendingConfirmation.actionType,
          await new OperatorTools(userId, channelIdentityId).executeConfirmedAction(
            pendingConfirmation.actionType,
            pendingConfirmation.actionParams,
          ),
        )
      : "Okay, cancelled — nothing was changed.";

    await repo.appendTurn(channelIdentityId, "user", turn.text);
    await repo.appendTurn(channelIdentityId, "assistant", responseText);
    return responseText;
  }

  const tools = new OperatorTools(userId, channelIdentityId);
  // One trace per turn (Langfuse, or a no-op when unconfigured — see
  // agent/llm/tracing.adapter.ts). sessionId groups every turn of one
  // conversation together in Langfuse's UI; channelIdentityId is exactly that
  // grouping key already (unique per channel+externalId, see schema.ts).
  const tracer = createTracer({
    name: "operator.turn",
    userId,
    sessionId: channelIdentityId,
    metadata: { channel: turn.channel, turnId },
  });
  const { responseText, toolCallCount } = await runAgentTurn(model, {
    prompt: turn.text,
    threadId: operatorThreadId(channelIdentityId),
    tools,
    log,
    tracer,
    ...(turn.onToolCall ? { onToolCall: turn.onToolCall } : {}),
  });

  await repo.appendTurn(channelIdentityId, "user", turn.text);
  await repo.appendTurn(channelIdentityId, "assistant", responseText);

  log.info("turn completed", { durationMs: Date.now() - startedAt, toolCalls: toolCallCount });

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
 * agent the note below with full tool access — so if the user's last request
 * needed this connection (e.g. "analyze my emails"), it gets carried out and
 * reported immediately instead of requiring the user to ask again. Callers
 * should fall back to a fixed confirmation if this throws (e.g. the LLM call
 * fails) — never let a broken resumption mean no confirmation arrives at all.
 */
export async function resumeConversationAfterEmailConnected(
  model: BaseChatModel,
  params: { channelIdentityId: string; userId: string; emailAddress: string },
): Promise<string> {
  const turnId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const log = logger.child({ turnId, userId: params.userId, source: "email_connected_resume" });
  log.info("resuming conversation after email connected");

  const repo = new ConversationRepo();
  const tools = new OperatorTools(params.userId, params.channelIdentityId);
  const note = buildEmailConnectedNote(params.emailAddress);
  const tracer = createTracer({
    name: "operator.turn",
    userId: params.userId,
    sessionId: params.channelIdentityId,
    metadata: { source: "email_connected_resume", turnId },
  });

  const { responseText, toolCallCount } = await runAgentTurn(model, {
    prompt: note,
    threadId: operatorThreadId(params.channelIdentityId),
    tools,
    log,
    tracer,
  });

  await repo.appendTurn(params.channelIdentityId, "user", note);
  await repo.appendTurn(params.channelIdentityId, "assistant", responseText);

  log.info("turn completed", { durationMs: Date.now() - startedAt, toolCalls: toolCallCount });

  return responseText;
}

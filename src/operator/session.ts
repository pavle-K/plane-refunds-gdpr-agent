import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { LlmClient, LlmConversationTurn } from "../agent/llm/llm.port.js";
import { ConversationRepo } from "../db/repositories/conversation.repo.js";
import { UserRepo } from "../db/repositories/user.repo.js";
import { PendingConfirmationRepo } from "../db/repositories/pending-confirmation.repo.js";
import { type ConsentGate, DbConsentGate, decideConsent, isAffirmativeReply, CONSENT_NOTICE } from "../compliance/consent.js";
import { TOOL_DEFINITIONS, OperatorTools, describeConfirmedActionResult } from "./tools.js";
import { logger, type Logger } from "../lib/logger.js";
import { createTracer, type Tracer } from "../agent/llm/index.js";

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
 * Shared by handleTurn and resumeConversationAfterEmailConnected — runs one
 * completeWithTools turn against the given tools instance, wiring the
 * dispatch/JSON-stringify/error-catch plumbing once instead of twice.
 *
 * Every tool call is logged at "info" (name + userId, no arguments) — that
 * alone is enough to answer "did the model call the tool or not" without
 * reading tea leaves out of a chat transcript, which is what this was built
 * for. Full arguments and the result go to "debug" (redacted — see
 * lib/logger.ts). A tool that throws is logged at "error" with the cause
 * before being handed back to the model as the same {error} string as
 * before — this used to be silently swallowed with no server-side trace at
 * all.
 *
 * Also records onto `tracer` (Langfuse, or a no-op — see
 * agent/llm/tracing.adapter.ts): each tool dispatch as a `span`, and the whole
 * completeWithTools call as a `generation`, both on the ONE trace the caller
 * created for this turn. This is queryable, persistent observability
 * (filterable/comparable in Langfuse's UI); `log` above is the local/immediate
 * text-log equivalent. Both are populated from the same data on purpose —
 * they serve different consumption modes, not redundant copies of one thing.
 */
async function runLlmTurn(
  llm: LlmClient,
  params: {
    prompt: string;
    history: LlmConversationTurn[];
    tools: OperatorTools;
    log: Logger;
    tracer: Tracer;
    onToolCall?: (call: { name: string; input: Record<string, unknown> }) => void;
  },
): Promise<{ responseText: string; toolCallCount: number }> {
  let toolCallCount = 0;
  const system = buildSystemPrompt();
  const startedAt = Date.now();

  const responseText = await llm.completeWithTools({
    system,
    prompt: params.prompt,
    tools: TOOL_DEFINITIONS,
    history: params.history,
    onToolCall: async (call) => {
      toolCallCount += 1;
      params.onToolCall?.(call);
      params.log.info("tool called", { tool: call.name });
      try {
        const result = await params.tools.dispatch(call.name, call.input);
        params.log.debug("tool result", { tool: call.name, input: call.input, result });
        params.tracer.span({ name: call.name, input: call.input, output: result });
        return JSON.stringify(result);
      } catch (cause) {
        params.log.error("tool dispatch threw", { tool: call.name, input: call.input, cause: String(cause) });
        params.tracer.span({ name: call.name, input: call.input, output: { error: String(cause) } });
        return JSON.stringify({ error: String(cause) });
      }
    },
  });

  params.tracer.generation({
    name: "operator.completeWithTools",
    input: { system, prompt: params.prompt, historyLength: params.history.length },
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
    log.info("consent gate blocked turn", { action: consentDecision.action });
    if (consentDecision.action === "consent_recorded") {
      await consentGate.recordConsent(userId, turn.channel);
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
  const { responseText, toolCallCount } = await runLlmTurn(llm, {
    prompt: turn.text,
    history,
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
  const turnId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const log = logger.child({ turnId, userId: params.userId, source: "email_connected_resume" });
  log.info("resuming conversation after email connected");

  const repo = new ConversationRepo();
  const history = await repo.loadHistory(params.channelIdentityId);
  const tools = new OperatorTools(params.userId, params.channelIdentityId);
  const note = buildEmailConnectedNote(params.emailAddress);
  const tracer = createTracer({
    name: "operator.turn",
    userId: params.userId,
    sessionId: params.channelIdentityId,
    metadata: { source: "email_connected_resume", turnId },
  });

  const { responseText, toolCallCount } = await runLlmTurn(llm, { prompt: note, history, tools, log, tracer });

  await repo.appendTurn(params.channelIdentityId, "user", note);
  await repo.appendTurn(params.channelIdentityId, "assistant", responseText);

  log.info("turn completed", { durationMs: Date.now() - startedAt, toolCalls: toolCallCount });

  return responseText;
}

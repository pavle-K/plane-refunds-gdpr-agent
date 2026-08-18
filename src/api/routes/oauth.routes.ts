import { Router, type Request, type Response } from "express";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { completeHostedFlow } from "../../providers/email-ingest/hosted-oauth.js";
import { createChannelAdapter } from "../../channels/index.js";
import type { ChannelAdapter } from "../../channels/channel.port.js";
import { ConversationRepo } from "../../db/repositories/conversation.repo.js";
import { UserRepo } from "../../db/repositories/user.repo.js";
import { resumeConversationAfterEmailConnected } from "../../operator/session.js";
import { logger } from "../../lib/logger.js";

/**
 * The public landing page a user's browser hits after they finish Google's or
 * Microsoft's consent screen. Deliberately minimal (per the chosen "minimal
 * static confirmation" design) — the real "you're connected" moment is the
 * proactive chat message sendConnectedNotification pushes below, not this
 * page. This route is fully self-contained and testable: given a pending-flow
 * row and a mocked token exchange, does it store the connection and reject
 * reuse/expiry/tampering, and does it notify the right chat on success.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(title: string, message: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; text-align: center; color: #222;">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>`;
}

const TRY_AGAIN_MESSAGE = "This link is no longer valid — please ask the bot to send you a new connection link.";

function fixedConnectedText(emailAddress: string): string {
  return `Connected — ${emailAddress} is linked. You can ask me to check your inbox now.`;
}

/**
 * Pushes the "you're connected" confirmation to the chat the flow was started
 * from. Prefers resumeConversationAfterEmailConnected — which feeds the LLM
 * the real conversation history plus tool access, so a pending request like
 * "analyze my emails" gets carried out immediately instead of just
 * acknowledged — and falls back to a fixed confirmation if that fails for any
 * reason (LLM call error, no linked user), so a broken resumption never means
 * silence instead of a confirmation. Never throws itself — a failed push
 * (e.g. the channel API is down) shouldn't turn a successful connection into
 * a failed HTTP response; it's logged instead. The connection itself is
 * already durably stored by the time this runs.
 */
async function sendConnectedNotification(
  model: BaseChatModel,
  channelIdentityId: string,
  emailAddress: string,
  getChannelAdapter: (channel: string) => ChannelAdapter,
): Promise<void> {
  const conversationRepo = new ConversationRepo();
  const identity = await conversationRepo.findChannelIdentity(channelIdentityId);
  if (!identity) {
    logger.error("OAuth callback: no channel identity found — cannot notify", { channelIdentityId });
    return;
  }

  let confirmationText: string;
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (userId) {
    try {
      confirmationText = await resumeConversationAfterEmailConnected(model, { channelIdentityId, userId, emailAddress });
    } catch (cause) {
      logger.error("OAuth callback: failed to resume the conversation via the LLM — falling back", {
        channelIdentityId,
        userId,
        cause: String(cause),
      });
      confirmationText = fixedConnectedText(emailAddress);
      await conversationRepo.appendTurn(channelIdentityId, "assistant", confirmationText);
    }
  } else {
    logger.error("OAuth callback: no user found for channel identity — cannot resume", { channelIdentityId });
    confirmationText = fixedConnectedText(emailAddress);
    await conversationRepo.appendTurn(channelIdentityId, "assistant", confirmationText);
  }

  try {
    const adapter = getChannelAdapter(identity.channel);
    const result = await adapter.sendMessage(identity.externalId, confirmationText);
    if (!result.ok) {
      logger.warn("OAuth callback: failed to notify user of connection", {
        channel: identity.channel,
        externalId: identity.externalId,
        errorType: result.error.type,
        message: result.error.message,
      });
    }
  } catch (cause) {
    logger.error("OAuth callback: unexpected error notifying user of connection", {
      channel: identity.channel,
      externalId: identity.externalId,
      cause: String(cause),
    });
  }
}

export function createOAuthCallbackRouter(
  model: BaseChatModel,
  getChannelAdapter: (channel: string) => ChannelAdapter = createChannelAdapter,
): Router {
  const router = Router();

  router.get("/oauth/:provider/callback", async (req: Request, res: Response) => {
    const provider = req.params["provider"];
    if (provider !== "gmail" && provider !== "outlook") {
      res.status(404).type("html").send(renderPage("Not found", "Unknown provider."));
      return;
    }

    const state = typeof req.query["state"] === "string" ? req.query["state"] : null;
    const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
    const error = typeof req.query["error"] === "string" ? req.query["error"] : null;

    if (!state) {
      res.status(400).type("html").send(renderPage("Something went wrong", TRY_AGAIN_MESSAGE));
      return;
    }

    let result;
    try {
      result = await completeHostedFlow(state, { code, error });
    } catch (cause) {
      // Covers misconfiguration (e.g. TOKEN_ENCRYPTION_KEY unset) and any
      // other unexpected throw — never let a raw error/stack trace reach the
      // browser, and never leave the request hanging.
      logger.error("OAuth callback threw", { provider, state, cause: String(cause) });
      res.status(500).type("html").send(renderPage("Something went wrong", TRY_AGAIN_MESSAGE));
      return;
    }

    if (!result.ok) {
      logger.error("OAuth callback failed", { provider, state, error: result.error });
      if (result.error.type === "provider_denied") {
        res
          .status(200)
          .type("html")
          .send(renderPage("No problem", "You can connect your inbox anytime by asking the bot to try again."));
        return;
      }
      res.status(400).type("html").send(renderPage("Something went wrong", TRY_AGAIN_MESSAGE));
      return;
    }

    res
      .status(200)
      .type("html")
      .send(renderPage("Connected", `${result.value.emailAddress} is now connected — you can return to your chat.`));

    await sendConnectedNotification(model, result.value.channelIdentityId, result.value.emailAddress, getChannelAdapter);
  });

  return router;
}

import { Router, type Request, type Response } from "express";
import { completeHostedFlow } from "../../providers/email-ingest/hosted-oauth.js";
import { createChannelAdapter } from "../../channels/index.js";
import type { ChannelAdapter } from "../../channels/channel.port.js";
import { ConversationRepo } from "../../db/repositories/conversation.repo.js";

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

/**
 * Pushes the "you're connected" confirmation to the chat the flow was started
 * from, and records the same text as an assistant-role turn so the LLM's
 * next-turn history stays consistent with what the user actually saw. Never
 * throws — a failed push (e.g. the channel API is down) shouldn't turn a
 * successful connection into a failed HTTP response; it's logged instead. The
 * connection itself is already durably stored by the time this runs.
 */
async function sendConnectedNotification(
  channelIdentityId: string,
  emailAddress: string,
  getChannelAdapter: (channel: string) => ChannelAdapter,
): Promise<void> {
  const conversationRepo = new ConversationRepo();
  const identity = await conversationRepo.findChannelIdentity(channelIdentityId);
  if (!identity) {
    console.error(`OAuth callback: no channel identity found for id ${channelIdentityId} — cannot notify.`);
    return;
  }

  const confirmationText = `Connected — ${emailAddress} is linked. You can ask me to check your inbox now.`;

  try {
    const adapter = getChannelAdapter(identity.channel);
    const result = await adapter.sendMessage(identity.externalId, confirmationText);
    if (!result.ok) {
      console.error(`OAuth callback: failed to notify ${identity.channel}:${identity.externalId}:`, result.error);
    }
  } catch (cause) {
    console.error(`OAuth callback: unexpected error notifying ${identity.channel}:${identity.externalId}:`, cause);
  }

  await conversationRepo.appendTurn(channelIdentityId, "assistant", confirmationText);
}

export function createOAuthCallbackRouter(getChannelAdapter: (channel: string) => ChannelAdapter = createChannelAdapter): Router {
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
      console.error(`OAuth callback threw (provider=${provider}, state=${state}):`, cause);
      res.status(500).type("html").send(renderPage("Something went wrong", TRY_AGAIN_MESSAGE));
      return;
    }

    if (!result.ok) {
      console.error(`OAuth callback failed (provider=${provider}, state=${state}):`, result.error);
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

    await sendConnectedNotification(result.value.channelIdentityId, result.value.emailAddress, getChannelAdapter);
  });

  return router;
}

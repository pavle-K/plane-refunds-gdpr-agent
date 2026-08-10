import { Router, type Request, type Response } from "express";
import { LlmRateLimitedError, type LlmClient } from "../../../agent/llm/llm.port.js";
import type { ChannelAdapter, InboundMessage } from "../../../channels/channel.port.js";
import { createTelegramAdapter, parseTelegramUpdate } from "../../../channels/telegram/index.js";
import { handleTurn } from "../../../operator/session.js";
import { env } from "../../../config/env.js";

/**
 * Telegram expects a fast 2xx or it'll retry the same update — so this acks
 * immediately and does the actual LLM turn + reply out-of-band, sending the
 * reply via a separate Bot API call rather than the webhook response body.
 */
export function createTelegramWebhookRouter(llm: LlmClient): Router {
  const router = Router();
  const adapter = createTelegramAdapter();

  router.post("/webhooks/telegram", (req: Request, res: Response) => {
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const receivedSecret = req.header("X-Telegram-Bot-Api-Secret-Token");
      if (receivedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
        res.sendStatus(401);
        return;
      }
    }

    res.sendStatus(200);

    const inbound = parseTelegramUpdate(req.body);
    if (!inbound) {
      return;
    }

    void replyToTelegramMessage(llm, adapter, inbound);
  });

  return router;
}

async function replyToTelegramMessage(llm: LlmClient, adapter: ChannelAdapter, inbound: InboundMessage): Promise<void> {
  try {
    const responseText = await handleTurn(llm, {
      channel: "telegram",
      externalId: inbound.externalUserId,
      text: inbound.text,
    });
    const result = await adapter.sendMessage(inbound.externalUserId, responseText);
    if (!result.ok) {
      console.error(`Failed to send Telegram reply to ${inbound.externalUserId}: ${result.error.type} — ${result.error.message}`);
    }
  } catch (cause) {
    console.error(`Unhandled error processing Telegram message from ${inbound.externalUserId}:`, cause);
    await adapter.sendMessage(inbound.externalUserId, describeUserFacingError(cause)).catch(() => {});
  }
}

/** A generic "something went wrong" is right for a truly unexpected error,
 * but a rate limit isn't unexpected or unusual enough to hide — the user can
 * actually act on "try again in a bit" in a way they can't act on a vague
 * failure message. Exported for direct unit testing — it's a pure function,
 * no need to exercise it only through the full webhook route. */
export function describeUserFacingError(cause: unknown): string {
  if (cause instanceof LlmRateLimitedError) {
    return cause.retryAfterSeconds !== undefined
      ? `I'm temporarily rate-limited by the AI provider — please try again in about ${Math.ceil(cause.retryAfterSeconds)}s.`
      : "I'm temporarily rate-limited by the AI provider — please try again shortly.";
  }
  return "Sorry, something went wrong on my end — please try again.";
}

import { Router, type Request, type Response } from "express";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { LlmRateLimitedError } from "../../../agent/llm/rate-limit-error.js";
import type { ChannelAdapter, InboundMessage } from "../../../channels/channel.port.js";
import { createTelegramAdapter, parseTelegramUpdate } from "../../../channels/telegram/index.js";
import { handleTurn } from "../../../operator/session.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";

/**
 * Telegram expects a fast 2xx or it'll retry the same update — so this acks
 * immediately and does the actual LLM turn + reply out-of-band, sending the
 * reply via a separate Bot API call rather than the webhook response body.
 */
export function createTelegramWebhookRouter(model: BaseChatModel): Router {
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

    void replyToTelegramMessage(model, adapter, inbound);
  });

  return router;
}

async function replyToTelegramMessage(model: BaseChatModel, adapter: ChannelAdapter, inbound: InboundMessage): Promise<void> {
  try {
    const responseText = await handleTurn(model, {
      channel: "telegram",
      externalId: inbound.externalUserId,
      text: inbound.text,
    });
    const result = await adapter.sendMessage(inbound.externalUserId, responseText);
    if (!result.ok) {
      logger.warn("failed to send Telegram reply", {
        externalId: inbound.externalUserId,
        errorType: result.error.type,
        message: result.error.message,
      });
    }
  } catch (cause) {
    logger.error("unhandled error processing Telegram message", {
      externalId: inbound.externalUserId,
      cause: String(cause),
    });
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

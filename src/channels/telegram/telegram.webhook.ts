import type { InboundMessage } from "../channel.port.js";

/**
 * Maps a raw Telegram Bot API update (https://core.telegram.org/bots/api#update)
 * to the shared InboundMessage shape. Returns null for anything that isn't a
 * plain text message in a private chat — edited messages, non-text content
 * (photos, stickers, ...), and group/channel updates are ignored for v1 rather
 * than guessed at.
 */
export function parseTelegramUpdate(body: unknown): InboundMessage | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const message = (body as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const text = (message as Record<string, unknown>)["text"];
  const chat = (message as Record<string, unknown>)["chat"];
  if (typeof text !== "string" || typeof chat !== "object" || chat === null) {
    return null;
  }

  const chatId = (chat as Record<string, unknown>)["id"];
  if (typeof chatId !== "number" && typeof chatId !== "string") {
    return null;
  }

  return { externalUserId: String(chatId), text };
}

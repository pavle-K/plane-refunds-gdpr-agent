import { ok, err, type Result } from "../../lib/result.js";
import type { ChannelAdapter, ChannelSendError } from "../channel.port.js";

interface TelegramApiResponse {
  ok: boolean;
  error_code?: number;
  description?: string;
}

/**
 * Real adapter against Telegram's Bot API. No SDK dependency — the Bot API is a
 * plain JSON/HTTPS API, same convention as google.adapter.ts and
 * postmark.adapter.ts. externalUserId here is Telegram's numeric chat id
 * (as a string), which telegram.webhook.ts extracts from inbound updates.
 */
export class TelegramAdapter implements ChannelAdapter {
  constructor(private readonly botToken: string) {}

  async sendMessage(externalUserId: string, text: string): Promise<Result<void, ChannelSendError>> {
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: externalUserId, text }),
      });
    } catch (cause) {
      return err({ type: "upstream_error", message: `Network error calling Telegram: ${String(cause)}` });
    }

    if (response.status === 401 || response.status === 403) {
      return err({ type: "auth_error", message: "Telegram rejected the bot token" });
    }
    if (response.status === 429) {
      return err({ type: "rate_limited", message: "Telegram rate-limited the request" });
    }

    let body: TelegramApiResponse;
    try {
      body = (await response.json()) as TelegramApiResponse;
    } catch (cause) {
      return err({ type: "upstream_error", message: `Malformed Telegram response: ${String(cause)}` });
    }

    if (!response.ok || !body.ok) {
      return err({
        type: "upstream_error",
        message: `Telegram returned HTTP ${response.status}${body.description ? `: ${body.description}` : ""}`,
      });
    }

    return ok(undefined);
  }
}

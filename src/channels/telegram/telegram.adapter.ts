import { ok, err, type Result } from "../../lib/result.js";
import type { ChannelAdapter, ChannelSendError } from "../channel.port.js";

interface TelegramApiResponse {
  ok: boolean;
  error_code?: number;
  description?: string;
}

/**
 * Defense-in-depth against Markdown-formatted links, e.g. `[label](url)` —
 * prompt.md tells the LLM to always give a bare URL instead (see its "Links"
 * rule) precisely because this send call has no parse_mode set, so Telegram
 * displays Markdown syntax as broken literal text rather than a clickable
 * link. That's a prompt instruction, not a guarantee — a model can still slip
 * and wrap a link anyway, and for something like an OAuth authorization URL
 * that's not a cosmetic issue, it makes the link fail outright. This strips
 * the wrapper and keeps just the URL, regardless of whether the model
 * followed the instruction.
 */
function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, "$2");
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
        body: JSON.stringify({ chat_id: externalUserId, text: stripMarkdownLinks(text) }),
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

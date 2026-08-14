import type { Result } from "../lib/result.js";

/** A platform-normalized inbound message — every webhook route maps its
 * platform's payload down to this before handing off to the operator session. */
export interface InboundMessage {
  externalUserId: string;
  text: string;
}

export type ChannelSendError =
  | { type: "auth_error"; message: string }
  | { type: "rate_limited"; message: string }
  | { type: "upstream_error"; message: string };

/** A file pushed to a user in the chat they're already in — today, the
 * print-and-post claim form. */
export interface OutboundDocument {
  filename: string;
  content: Buffer;
  contentType: string;
}

/** What every messaging channel adapter implements — Telegram, Discord,
 * WhatsApp, Viber, Facebook. Webhook parsing is adapter-specific (it lives
 * next to each adapter, e.g. telegram.webhook.ts) since inbound payload shapes
 * don't unify the way "send a text message back" does. */
export interface ChannelAdapter {
  sendMessage(externalUserId: string, text: string): Promise<Result<void, ChannelSendError>>;
  /**
   * Optional: a channel that has no file transport simply doesn't implement it,
   * and callers fall back to describing the document instead of pretending it
   * arrived. Declared optional rather than forcing every adapter to stub a
   * failure, so "this channel can't do files" is answerable without calling it.
   */
  sendDocument?(
    externalUserId: string,
    document: OutboundDocument,
    caption?: string,
  ): Promise<Result<void, ChannelSendError>>;
}

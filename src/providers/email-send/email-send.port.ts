import type { Result } from "../../lib/result.js";

export interface OutboundAttachment {
  filename: string;
  /** Raw bytes. Base64-encoded by the adapter, not the caller. */
  content: Buffer;
  contentType: string;
}

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  textBody: string;
  /** Optional so every existing caller compiles unchanged. Providers cap total
   * message size (Postmark at 10MB after base64 inflation), so adapters are
   * expected to reject an oversized send rather than let it fail upstream. */
  attachments?: OutboundAttachment[] | undefined;
}

export interface SendReceipt {
  messageId: string;
  sentAtUtc: string;
}

export type EmailSendError =
  | { type: "auth_error"; message: string }
  | { type: "rate_limited"; message: string }
  | { type: "upstream_error"; message: string };

export interface EmailSendProvider {
  send(email: OutboundEmail): Promise<Result<SendReceipt, EmailSendError>>;
}

import type { Result } from "../../lib/result.js";

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  textBody: string;
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

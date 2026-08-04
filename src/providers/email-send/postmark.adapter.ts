import { ok, err, type Result } from "../../lib/result.js";
import type { EmailSendProvider, OutboundEmail, SendReceipt, EmailSendError } from "./email-send.port.js";

/**
 * Real adapter against the Postmark transactional email API. UNVERIFIED against a
 * live response (no POSTMARK_API_KEY yet) — Postmark's send API is simple and very
 * stable/well-documented, so this is lower-risk than the AeroAPI adapter, but
 * confirm the response shape against a real call before trusting it in production.
 */
const SEND_URL = "https://api.postmarkapp.com/email";

interface PostmarkSendResponse {
  MessageID: string;
  SubmittedAt: string;
  ErrorCode: number;
  Message: string;
}

export class PostmarkEmailSendAdapter implements EmailSendProvider {
  constructor(private readonly serverToken: string) {}

  async send(email: OutboundEmail): Promise<Result<SendReceipt, EmailSendError>> {
    let response: Response;
    try {
      response = await fetch(SEND_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": this.serverToken,
        },
        body: JSON.stringify({
          From: email.from,
          To: email.to,
          Subject: email.subject,
          TextBody: email.textBody,
        }),
      });
    } catch (cause) {
      return err({ type: "upstream_error", message: `Network error calling Postmark: ${String(cause)}` });
    }

    if (response.status === 401) {
      return err({ type: "auth_error", message: "Postmark rejected the server token" });
    }
    if (response.status === 429) {
      return err({ type: "rate_limited", message: "Postmark rate-limited the request" });
    }
    if (!response.ok) {
      const bodyText = await response.text();
      return err({ type: "upstream_error", message: `Postmark returned HTTP ${response.status}: ${bodyText}` });
    }

    let body: PostmarkSendResponse;
    try {
      body = (await response.json()) as PostmarkSendResponse;
    } catch (cause) {
      return err({ type: "upstream_error", message: `Malformed Postmark response: ${String(cause)}` });
    }

    if (body.ErrorCode !== 0) {
      return err({ type: "upstream_error", message: `Postmark error ${body.ErrorCode}: ${body.Message}` });
    }

    return ok({ messageId: body.MessageID, sentAtUtc: body.SubmittedAt });
  }
}

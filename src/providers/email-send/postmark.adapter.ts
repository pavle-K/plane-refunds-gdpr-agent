import { ok, err, type Result } from "../../lib/result.js";
import type { EmailSendProvider, OutboundEmail, SendReceipt, EmailSendError } from "./email-send.port.js";

/**
 * Real adapter against the Postmark transactional email API. UNVERIFIED against a
 * live response (no POSTMARK_API_KEY yet) — Postmark's send API is simple and very
 * stable/well-documented, so this is lower-risk than the AeroAPI adapter, but
 * confirm the response shape against a real call before trusting it in production.
 */
const SEND_URL = "https://api.postmarkapp.com/email";
const MAX_ATTACHMENT_BYTES_BASE64 = 10 * 1024 * 1024;

interface PostmarkSendResponse {
  MessageID: string;
  SubmittedAt: string;
  ErrorCode: number;
  Message: string;
}

export class PostmarkEmailSendAdapter implements EmailSendProvider {
  constructor(private readonly serverToken: string) {}

  async send(email: OutboundEmail): Promise<Result<SendReceipt, EmailSendError>> {
    // Postmark caps a message at 10MB, measured AFTER base64 inflation (~4/3).
    // Failing here names the real problem; letting it through produces an
    // opaque upstream error at the point a user is waiting on a document.
    const attachmentBytes = (email.attachments ?? []).reduce((total, a) => total + a.content.byteLength, 0);
    if (attachmentBytes * (4 / 3) > MAX_ATTACHMENT_BYTES_BASE64) {
      return err({
        type: "upstream_error",
        message: `Attachments total ${attachmentBytes} bytes, which exceeds Postmark's 10MB limit once base64-encoded`,
      });
    }

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
          ...(email.attachments?.length
            ? {
                Attachments: email.attachments.map((attachment) => ({
                  Name: attachment.filename,
                  Content: attachment.content.toString("base64"),
                  ContentType: attachment.contentType,
                })),
              }
            : {}),
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

import type { Result } from "../../lib/result.js";

export interface EmailAttachment {
  filename: string;
  mimeType: string;
}

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  receivedAtUtc: string;
  bodyText: string;
  /** Metadata only — fetch content on demand via getAttachmentText, since most
   * scans never need it (see providers/email-ingest/llm-extractor.ts). */
  attachments: EmailAttachment[];
}

export interface EmailIngestQuery {
  /** Only return messages received after this ISO timestamp. */
  sinceUtc: string;
  /** Only return messages received before this ISO timestamp, if given — for
   * scanning a bounded historical range rather than "everything since X". */
  untilUtc?: string;
}

export type EmailIngestError =
  | { type: "auth_error"; message: string }
  | { type: "rate_limited"; message: string }
  | { type: "not_found"; message: string }
  | { type: "unsupported_attachment"; message: string }
  | { type: "upstream_error"; message: string };

export interface EmailListResult {
  messages: EmailMessage[];
  /** True if more matching messages existed than were fetched (an internal
   * safety cap was hit) — the caller asked for a broader range than got fully
   * covered. Never drop this silently; narrow the range or page further. */
  truncated: boolean;
}

export interface EmailIngestProvider {
  /**
   * Read-only, narrow-scope inbox access — this is the
   * one provider that touches raw user PII directly; keep field-level minimization
   * in mind for anything built on top of this, e.g. src/compliance/redaction.ts).
   */
  listRecentMessages(query: EmailIngestQuery): Promise<Result<EmailListResult, EmailIngestError>>;

  /** Fetches a specific attachment and extracts its text (PDF supported today —
   * other types return an "unsupported_attachment" error rather than garbage). */
  getAttachmentText(messageId: string, filename: string): Promise<Result<string, EmailIngestError>>;
}

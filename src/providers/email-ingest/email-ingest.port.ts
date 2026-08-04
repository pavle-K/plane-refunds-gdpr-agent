import type { Result } from "../../lib/result.js";

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  receivedAtUtc: string;
  bodyText: string;
}

export interface EmailIngestQuery {
  /** Only return messages received after this ISO timestamp. */
  sinceUtc: string;
}

export type EmailIngestError =
  | { type: "auth_error"; message: string }
  | { type: "rate_limited"; message: string }
  | { type: "upstream_error"; message: string };

export interface EmailIngestProvider {
  /**
   * Read-only, narrow-scope inbox access (see CLAUDE.md §2.3/§2.4 — this is the
   * one provider that touches raw user PII directly; keep field-level minimization
   * in mind for anything built on top of this, e.g. src/compliance/redaction.ts).
   */
  listRecentMessages(query: EmailIngestQuery): Promise<Result<EmailMessage[], EmailIngestError>>;
}

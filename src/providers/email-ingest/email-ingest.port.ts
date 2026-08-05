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
  /** Only return messages received before this ISO timestamp, if given — for
   * scanning a bounded historical range rather than "everything since X". */
  untilUtc?: string;
}

export type EmailIngestError =
  | { type: "auth_error"; message: string }
  | { type: "rate_limited"; message: string }
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
   * Read-only, narrow-scope inbox access (see CLAUDE.md §2.3/§2.4 — this is the
   * one provider that touches raw user PII directly; keep field-level minimization
   * in mind for anything built on top of this, e.g. src/compliance/redaction.ts).
   */
  listRecentMessages(query: EmailIngestQuery): Promise<Result<EmailListResult, EmailIngestError>>;
}

import { ok, type Result } from "../../lib/result.js";
import type {
  EmailIngestProvider,
  EmailIngestQuery,
  EmailMessage,
  EmailListResult,
  EmailIngestError,
} from "./email-ingest.port.js";

/** In-memory adapter for tests and local dev. Seed it, never hits the network. */
export class FakeEmailIngestAdapter implements EmailIngestProvider {
  private messages: EmailMessage[] = [];

  seedMessages(messages: EmailMessage[]): void {
    this.messages = messages;
  }

  async listRecentMessages(
    query: EmailIngestQuery,
  ): Promise<Result<EmailListResult, EmailIngestError>> {
    const since = new Date(query.sinceUtc).getTime();
    const until = query.untilUtc ? new Date(query.untilUtc).getTime() : null;
    const messages = this.messages.filter((m) => {
      const receivedAt = new Date(m.receivedAtUtc).getTime();
      return receivedAt > since && (until === null || receivedAt < until);
    });
    return ok({ messages, truncated: false });
  }
}

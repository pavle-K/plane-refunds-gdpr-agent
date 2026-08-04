import { ok, type Result } from "../../lib/result.js";
import type {
  EmailIngestProvider,
  EmailIngestQuery,
  EmailMessage,
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
  ): Promise<Result<EmailMessage[], EmailIngestError>> {
    const since = new Date(query.sinceUtc).getTime();
    return ok(this.messages.filter((m) => new Date(m.receivedAtUtc).getTime() > since));
  }
}

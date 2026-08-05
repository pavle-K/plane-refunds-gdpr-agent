import { ok, err, type Result } from "../../lib/result.js";
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
  private readonly attachmentTexts = new Map<string, string>();

  seedMessages(messages: EmailMessage[]): void {
    this.messages = messages;
  }

  /** Key format: "<messageId>/<filename>". */
  seedAttachmentText(messageId: string, filename: string, text: string): void {
    this.attachmentTexts.set(`${messageId}/${filename}`, text);
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

  async getAttachmentText(messageId: string, filename: string): Promise<Result<string, EmailIngestError>> {
    const text = this.attachmentTexts.get(`${messageId}/${filename}`);
    if (text === undefined) {
      return err({ type: "not_found", message: `No seeded attachment text for ${messageId}/${filename}` });
    }
    return ok(text);
  }
}

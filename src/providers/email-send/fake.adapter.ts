import { ok, type Result } from "../../lib/result.js";
import type { EmailSendProvider, OutboundEmail, SendReceipt, EmailSendError } from "./email-send.port.js";

/**
 * Records sends instead of sending. This is the adapter every test in the
 * project uses — a test that can actually email an airline is a test that will,
 * eventually, email an airline.
 */
export class FakeEmailSendAdapter implements EmailSendProvider {
  readonly sentEmails: OutboundEmail[] = [];
  private nextResult: Result<SendReceipt, EmailSendError> | null = null;
  private messageCounter = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Override the result of the next send() call, e.g. to simulate a failure. */
  queueResult(result: Result<SendReceipt, EmailSendError>): void {
    this.nextResult = result;
  }

  async send(email: OutboundEmail): Promise<Result<SendReceipt, EmailSendError>> {
    this.sentEmails.push(email);

    if (this.nextResult) {
      const result = this.nextResult;
      this.nextResult = null;
      return result;
    }

    this.messageCounter += 1;
    return ok({
      messageId: `fake-message-${this.messageCounter}`,
      sentAtUtc: this.clock().toISOString(),
    });
  }
}

import { ok, type Result } from "../lib/result.js";
import type { ChannelAdapter, ChannelSendError } from "./channel.port.js";

/**
 * Records sends instead of hitting a real messaging API. Used by every test in
 * this project and as the fallback whenever a channel's credentials aren't
 * configured — matches the convention in src/providers/*\/fake.adapter.ts.
 */
export class FakeChannelAdapter implements ChannelAdapter {
  readonly sentMessages: { externalUserId: string; text: string }[] = [];
  private nextResult: Result<void, ChannelSendError> | null = null;

  /** Override the result of the next sendMessage() call, e.g. to simulate a failure. */
  queueResult(result: Result<void, ChannelSendError>): void {
    this.nextResult = result;
  }

  async sendMessage(externalUserId: string, text: string): Promise<Result<void, ChannelSendError>> {
    this.sentMessages.push({ externalUserId, text });

    if (this.nextResult) {
      const result = this.nextResult;
      this.nextResult = null;
      return result;
    }
    return ok(undefined);
  }
}

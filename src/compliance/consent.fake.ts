import type { ConsentGate } from "./consent.js";

/** In-memory consent gate for node/unit tests — never touches the database. */
export class FakeConsentGate implements ConsentGate {
  readonly consentedUserIds = new Set<string>();
  readonly recordedChannelsByUserId = new Map<string, string>();

  async hasConsented(userId: string): Promise<boolean> {
    return this.consentedUserIds.has(userId);
  }

  async recordConsent(userId: string, channel: string): Promise<void> {
    this.consentedUserIds.add(userId);
    this.recordedChannelsByUserId.set(userId, channel);
  }
}

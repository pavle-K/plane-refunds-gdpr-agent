import { ConsentRepo } from "../db/repositories/consent.repo.js";

/**
 * Bump this whenever CONSENT_NOTICE changes in a way that matters (what data
 * is processed, retention, rights) — every recorded consent stores the
 * version shown at the time, so we can always prove what a given user agreed
 * to. Cosmetic wording tweaks don't need a bump; substantive ones do.
 *
 * PLACEHOLDER: the notice text below is a stand-in — it needs a real privacy
 * policy link and company/DPO contact details before this reaches real users.
 */
export const CURRENT_POLICY_VERSION = "v1-placeholder";

export const CONSENT_NOTICE = `Before we get started, here's what this bot does with your data:

- If you connect an email account, we only read booking-confirmation emails to find flight details — nothing else in your inbox is read or stored.
- Flight, booking, and passenger details you share are used to check EC261 compensation eligibility and, only with your explicit approval, to draft and send a claim to the airline on your behalf.
- Your data is kept only as long as your claim is active plus the legally required window, then deleted. You can ask to see or delete everything we hold on you at any time.

[PLACEHOLDER: full privacy policy — replace with a real URL and company/contact details before this reaches real users.]

Reply "yes" to continue, or ask me anything about this first.`;

export const CONSENT_WELCOME_TEXT =
  "Thanks — you're all set. Tell me about a flight you'd like to check, or ask me to connect your inbox.";

/**
 * Deliberately not an LLM judgment call — same principle as this repo's
 * approval-gate rule (see src/operator/prompt.md): nothing legally load-bearing
 * gets decided by a model. A conservative allowlist of common affirmative
 * replies; anything else (including silence, a question, or "maybe") falls
 * through to re-showing the notice rather than being treated as consent.
 */
const AFFIRMATIVE_REPLY_PATTERN = /^(yes|yep|yeah|y|i agree|agree|ok|okay|sure|confirm|confirmed)[.!]?$/i;

export function isAffirmativeReply(text: string): boolean {
  return AFFIRMATIVE_REPLY_PATTERN.test(text.trim());
}

export type ConsentDecision =
  | { action: "proceed" }
  | { action: "consent_recorded"; responseText: string }
  | { action: "show_notice"; responseText: string };

/**
 * Pure decision logic for the consent gate — no I/O, so it's exhaustively
 * unit-testable without a database, an LLM, or the operator tools. The only
 * caller (src/operator/session.ts) does nothing except look up
 * hasConsented/noticeAlreadyShown from storage, call this, and act on the
 * result; it never invokes the LLM or any tool unless this returns "proceed".
 *
 * noticeAlreadyShown — not "has this identity ever sent a message" — is what
 * gates auto-consent. Two reasons that distinction matters: a brand-new
 * user's very first message could coincidentally BE the word "yes", which
 * must never auto-consent to a notice they weren't just shown; and an
 * identity that talked to this bot before the consent system existed already
 * has conversation history but has *never* seen this notice either. Only a
 * reply sent after the notice was actually shown can record consent.
 */
export function decideConsent(input: {
  alreadyConsented: boolean;
  noticeAlreadyShown: boolean;
  messageText: string;
}): ConsentDecision {
  if (input.alreadyConsented) {
    return { action: "proceed" };
  }
  if (input.noticeAlreadyShown && isAffirmativeReply(input.messageText)) {
    return { action: "consent_recorded", responseText: CONSENT_WELCOME_TEXT };
  }
  return { action: "show_notice", responseText: CONSENT_NOTICE };
}

export interface ConsentGate {
  hasConsented(userId: string): Promise<boolean>;
  recordConsent(userId: string, channel: string): Promise<void>;
}

export class DbConsentGate implements ConsentGate {
  constructor(private readonly repo: ConsentRepo = new ConsentRepo()) {}

  async hasConsented(userId: string): Promise<boolean> {
    return this.repo.hasConsented(userId);
  }

  async recordConsent(userId: string, channel: string): Promise<void> {
    await this.repo.record({ userId, policyVersion: CURRENT_POLICY_VERSION, channel });
  }
}

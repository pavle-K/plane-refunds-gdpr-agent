import { describe, it, expect } from "vitest";
import { decideConsent, isAffirmativeReply, CONSENT_NOTICE, CONSENT_WELCOME_TEXT } from "../../../src/compliance/consent.js";
import { FakeConsentGate } from "../../../src/compliance/consent.fake.js";

describe("isAffirmativeReply", () => {
  it.each(["yes", "Yes", "YES!", "yep", "yeah", "y", "i agree", "agree", "ok", "okay", "sure", "confirm", "confirmed."])(
    "treats %j as affirmative",
    (text) => {
      expect(isAffirmativeReply(text)).toBe(true);
    },
  );

  it.each(["", "no", "maybe", "yes please connect my gmail", "what data do you collect?", "y not sure", "ok but why"])(
    "does not treat %j as affirmative",
    (text) => {
      expect(isAffirmativeReply(text)).toBe(false);
    },
  );
});

describe("decideConsent", () => {
  it("proceeds straight through once already consented, regardless of message text", () => {
    const decision = decideConsent({ alreadyConsented: true, noticeAlreadyShown: true, messageText: "check my flight" });
    expect(decision).toEqual({ action: "proceed" });
  });

  it("shows the notice when it hasn't been shown yet and never auto-consents, even if the message happens to be 'yes'", () => {
    const decision = decideConsent({ alreadyConsented: false, noticeAlreadyShown: false, messageText: "yes" });
    expect(decision).toEqual({ action: "show_notice", responseText: CONSENT_NOTICE });
  });

  it("shows the notice for an identity with prior conversation history that predates the consent system", () => {
    // noticeAlreadyShown: false here models an identity that has chatted before
    // but never saw THIS notice — not just a brand-new identity.
    const decision = decideConsent({ alreadyConsented: false, noticeAlreadyShown: false, messageText: "ok" });
    expect(decision).toEqual({ action: "show_notice", responseText: CONSENT_NOTICE });
  });

  it("records consent when an affirmative reply follows a notice that was already shown", () => {
    const decision = decideConsent({ alreadyConsented: false, noticeAlreadyShown: true, messageText: "yes" });
    expect(decision).toEqual({ action: "consent_recorded", responseText: CONSENT_WELCOME_TEXT });
  });

  it("re-shows the notice on an ambiguous reply instead of silently passing through", () => {
    const decision = decideConsent({
      alreadyConsented: false,
      noticeAlreadyShown: true,
      messageText: "what exactly do you store?",
    });
    expect(decision).toEqual({ action: "show_notice", responseText: CONSENT_NOTICE });
  });
});

describe("FakeConsentGate", () => {
  it("tracks consent per user without touching the database", async () => {
    const gate = new FakeConsentGate();
    const userId = "user-1";

    expect(await gate.hasConsented(userId)).toBe(false);

    await gate.recordConsent(userId, "telegram");

    expect(await gate.hasConsented(userId)).toBe(true);
    expect(await gate.hasConsented("someone-else")).toBe(false);
    expect(gate.recordedChannelsByUserId.get(userId)).toBe("telegram");
  });
});

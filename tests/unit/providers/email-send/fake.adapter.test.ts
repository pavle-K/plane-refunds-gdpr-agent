import { describe, it, expect } from "vitest";
import { FakeEmailSendAdapter } from "../../../../src/providers/email-send/fake.adapter.js";
import { err } from "../../../../src/lib/result.js";

const EMAIL = { to: "claims@airline.example", from: "user@example.com", subject: "Claim", textBody: "body" };

describe("FakeEmailSendAdapter", () => {
  it("records the sent email instead of sending it", async () => {
    const adapter = new FakeEmailSendAdapter();
    await adapter.send(EMAIL);
    expect(adapter.sentEmails).toEqual([EMAIL]);
  });

  it("returns a successful receipt with an incrementing message id", async () => {
    const adapter = new FakeEmailSendAdapter();
    const first = await adapter.send(EMAIL);
    const second = await adapter.send(EMAIL);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.messageId).not.toBe(second.value.messageId);
    }
  });

  it("can be queued to simulate a failed send", async () => {
    const adapter = new FakeEmailSendAdapter();
    adapter.queueResult(err({ type: "upstream_error", message: "simulated failure" }));

    const result = await adapter.send(EMAIL);
    expect(result).toEqual(err({ type: "upstream_error", message: "simulated failure" }));
    // Still recorded — the attempt happened even though it "failed".
    expect(adapter.sentEmails).toEqual([EMAIL]);
  });
});

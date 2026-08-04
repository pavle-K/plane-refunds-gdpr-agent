import { describe, it, expect } from "vitest";
import { FakeEmailIngestAdapter } from "../../../../src/providers/email-ingest/fake.adapter.js";
import type { EmailMessage } from "../../../../src/providers/email-ingest/email-ingest.port.js";

const OLD: EmailMessage = {
  id: "1",
  from: "a@example.com",
  subject: "old",
  receivedAtUtc: "2024-01-01T00:00:00.000Z",
  bodyText: "old",
};

const NEW: EmailMessage = {
  id: "2",
  from: "b@example.com",
  subject: "new",
  receivedAtUtc: "2024-06-01T00:00:00.000Z",
  bodyText: "new",
};

describe("FakeEmailIngestAdapter", () => {
  it("only returns messages received after the given timestamp", async () => {
    const adapter = new FakeEmailIngestAdapter();
    adapter.seedMessages([OLD, NEW]);

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-03-01T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([NEW]);
    }
  });

  it("returns an empty array when nothing is seeded", async () => {
    const adapter = new FakeEmailIngestAdapter();
    const result = await adapter.listRecentMessages({ sinceUtc: "2024-01-01T00:00:00.000Z" });
    expect(result).toEqual({ ok: true, value: [] });
  });
});

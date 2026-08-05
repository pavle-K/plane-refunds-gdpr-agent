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

const NEWEST: EmailMessage = {
  id: "3",
  from: "c@example.com",
  subject: "newest",
  receivedAtUtc: "2024-09-01T00:00:00.000Z",
  bodyText: "newest",
};

describe("FakeEmailIngestAdapter", () => {
  it("only returns messages received after the given timestamp", async () => {
    const adapter = new FakeEmailIngestAdapter();
    adapter.seedMessages([OLD, NEW]);

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-03-01T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ messages: [NEW], truncated: false });
    }
  });

  it("respects an explicit untilUtc upper bound, for scanning a bounded past range", async () => {
    const adapter = new FakeEmailIngestAdapter();
    adapter.seedMessages([OLD, NEW, NEWEST]);

    const result = await adapter.listRecentMessages({
      sinceUtc: "2024-01-15T00:00:00.000Z",
      untilUtc: "2024-07-01T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ messages: [NEW], truncated: false });
    }
  });

  it("returns an empty array when nothing is seeded", async () => {
    const adapter = new FakeEmailIngestAdapter();
    const result = await adapter.listRecentMessages({ sinceUtc: "2024-01-01T00:00:00.000Z" });
    expect(result).toEqual({ ok: true, value: { messages: [], truncated: false } });
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { GmailAdapter } from "../../../../src/providers/email-ingest/gmail.adapter.js";

/**
 * Fixtures are a best-effort reconstruction of Gmail API v1's documented
 * response shape, NOT captured from a real call — see the adapter's header
 * comment. Re-verify once a real Gmail connection exists.
 */
const LIST_RESPONSE = { messages: [{ id: "msg-1", threadId: "thread-1" }], resultSizeEstimate: 1 };

const DETAIL_RESPONSE = {
  id: "msg-1",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "noreply@britishairways.com" },
      { name: "Subject", value: "Your booking confirmation" },
      { name: "Date", value: "Sat, 15 Jun 2024 09:00:00 +0000" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: { data: "Qm9va2luZyByZWZlcmVuY2U6IFhSN0syUApGbGlnaHQ6IEJBMTIzCkRhdGU6IDIwMjQtMDYtMTUK" },
      },
      { mimeType: "text/html", body: { data: "PGgxPkhUTUwgdmVyc2lvbjwvaDE+" } },
    ],
  },
};

function mockGmailFetch() {
  const fn = vi.fn((url: string | URL) => {
    const isDetail = String(url).includes("/messages/msg-1?format=full");
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(isDetail ? DETAIL_RESPONSE : LIST_RESPONSE),
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GmailAdapter", () => {
  it("lists messages and decodes the plain-text part from a multipart body", async () => {
    mockGmailFetch();
    const adapter = new GmailAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.from).toBe("noreply@britishairways.com");
      expect(result.value[0]?.subject).toBe("Your booking confirmation");
      expect(result.value[0]?.bodyText).toContain("Booking reference: XR7K2P");
      expect(result.value[0]?.bodyText).not.toContain("HTML version"); // picked text/plain, not text/html
    }
  });

  it("returns an empty array when there are no messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    );
    const adapter = new GmailAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("returns a typed auth_error on HTTP 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const adapter = new GmailAdapter(async () => "expired-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("auth_error");
    }
  });

  it("returns a typed rate_limited error on HTTP 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const adapter = new GmailAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("rate_limited");
    }
  });

  it("returns a typed upstream_error on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const adapter = new GmailAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });
});

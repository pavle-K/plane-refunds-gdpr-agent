import { describe, it, expect, afterEach, vi } from "vitest";
import { GmailAdapter } from "../../../../src/providers/email-ingest/gmail.adapter.js";

vi.mock("../../../../src/lib/pdf-text.js", () => ({
  extractPdfText: vi.fn().mockResolvedValue("Turkish Airlines • TK1867\nTurkish Airlines • TK57"),
}));

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
      expect(result.value.truncated).toBe(false);
      expect(result.value.messages).toHaveLength(1);
      expect(result.value.messages[0]?.from).toBe("noreply@britishairways.com");
      expect(result.value.messages[0]?.subject).toBe("Your booking confirmation");
      expect(result.value.messages[0]?.bodyText).toContain("Booking reference: XR7K2P");
      expect(result.value.messages[0]?.bodyText).not.toContain("HTML version"); // picked text/plain, not text/html
    }
  });

  it("includes a before: term in the search query when untilUtc is given", async () => {
    const fetchMock = mockGmailFetch();
    const adapter = new GmailAdapter(async () => "fake-access-token");

    await adapter.listRecentMessages({ sinceUtc: "2024-02-01T00:00:00.000Z", untilUtc: "2024-03-31T23:59:59.000Z" });

    const firstCallUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(firstCallUrl).toContain("after%3A2024%2F02%2F01");
    expect(firstCallUrl).toContain("before%3A2024%2F03%2F31");
  });

  it("follows nextPageToken across multiple pages instead of stopping at the first page", async () => {
    function detailFor(id: string) {
      return {
        id,
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: `sender-${id}@example.com` },
            { name: "Subject", value: `Subject ${id}` },
          ],
          body: { data: Buffer.from(`body ${id}`).toString("base64") },
        },
      };
    }

    const fetchMock = vi.fn((url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/messages/m1?format=full")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(detailFor("m1")) });
      }
      if (urlStr.includes("/messages/m2?format=full")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(detailFor("m2")) });
      }
      if (urlStr.includes("/messages/m3?format=full")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(detailFor("m3")) });
      }
      // list calls
      if (urlStr.includes("pageToken=page2")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ messages: [{ id: "m3" }] }) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "page2" }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new GmailAdapter(async () => "fake-access-token");
    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.truncated).toBe(false);
      expect(result.value.messages.map((m) => m.id).sort()).toEqual(["m1", "m2", "m3"]);
    }

    const listCalls = fetchMock.mock.calls.filter((c) => !String(c[0]).includes("/messages/m"));
    expect(listCalls).toHaveLength(2); // proves it actually paginated, not just one page
  });

  it("marks truncated=true when the message cap is hit but more pages exist", async () => {
    function detailFor(id: string) {
      return {
        id,
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "From", value: `sender-${id}@example.com` }, { name: "Subject", value: id }],
          body: { data: Buffer.from(`body ${id}`).toString("base64") },
        },
      };
    }

    const fetchMock = vi.fn((url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/messages/m1?format=full")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(detailFor("m1")) });
      }
      if (urlStr.includes("pageToken=page2")) {
        // A real API would return more here — the adapter must never fetch this
        // page once the cap is hit, or the point of the cap is defeated.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ messages: [{ id: "should-not-be-fetched" }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ messages: [{ id: "m1" }], nextPageToken: "page2" }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Cap of 1 — the first page already meets it, so it must stop there and
    // report truncated even though the API says there's a next page.
    const adapter = new GmailAdapter(async () => "fake-access-token", 1);
    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.truncated).toBe(true);
      expect(result.value.messages.map((m) => m.id)).toEqual(["m1"]);
    }
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("pageToken=page2"))).toBe(false);
  });

  it("returns an empty array when there are no messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    );
    const adapter = new GmailAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result).toEqual({ ok: true, value: { messages: [], truncated: false } });
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

describe("GmailAdapter — attachments", () => {
  const DETAIL_WITH_PDF = {
    id: "msg-pdf",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: "Your trip is confirmed" }],
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("see attached").toString("base64") } },
        {
          mimeType: "application/pdf",
          filename: "Receipt_1119-971-928.pdf",
          body: { attachmentId: "att-1", size: 15964 },
        },
      ],
    },
  };

  it("surfaces attachment metadata when listing messages", async () => {
    const fetchMock = vi.fn((url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/messages/msg-pdf?format=full")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DETAIL_WITH_PDF) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ messages: [{ id: "msg-pdf" }] }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new GmailAdapter(async () => "fake-access-token");
    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages[0]?.attachments).toEqual([
        { filename: "Receipt_1119-971-928.pdf", mimeType: "application/pdf" },
      ]);
    }
  });

  it("extracts PDF text via getAttachmentText", async () => {
    const fetchMock = vi.fn((url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/attachments/att-1")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: Buffer.from("fake pdf bytes").toString("base64") }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DETAIL_WITH_PDF) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new GmailAdapter(async () => "fake-access-token");
    const result = await adapter.getAttachmentText("msg-pdf", "Receipt_1119-971-928.pdf");

    expect(result).toEqual({ ok: true, value: "Turkish Airlines • TK1867\nTurkish Airlines • TK57" });
  });

  it("returns not_found for a nonexistent attachment filename", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(DETAIL_WITH_PDF) }),
    );
    const adapter = new GmailAdapter(async () => "fake-access-token");

    const result = await adapter.getAttachmentText("msg-pdf", "does-not-exist.pdf");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("returns unsupported_attachment for a non-PDF, non-text attachment", async () => {
    const detailWithImage = {
      ...DETAIL_WITH_PDF,
      payload: {
        ...DETAIL_WITH_PDF.payload,
        parts: [
          {
            mimeType: "image/png",
            filename: "photo.png",
            body: { attachmentId: "att-2", size: 1000 },
          },
        ],
      },
    };
    const fetchMock = vi.fn((url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/attachments/att-2")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: Buffer.from("fake png bytes").toString("base64") }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(detailWithImage) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new GmailAdapter(async () => "fake-access-token");

    const result = await adapter.getAttachmentText("msg-pdf", "photo.png");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("unsupported_attachment");
    }
  });
});

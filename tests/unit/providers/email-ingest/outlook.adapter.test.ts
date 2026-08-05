import { describe, it, expect, afterEach, vi } from "vitest";
import { OutlookAdapter } from "../../../../src/providers/email-ingest/outlook.adapter.js";

vi.mock("../../../../src/lib/pdf-text.js", () => ({
  extractPdfText: vi.fn().mockResolvedValue("Turkish Airlines • TK1867\nTurkish Airlines • TK57"),
}));

/**
 * Fixture is a best-effort reconstruction of Microsoft Graph's documented
 * /me/messages response shape, NOT captured from a real call — see the
 * adapter's header comment. Re-verify once a real Outlook connection exists.
 */
const GRAPH_RESPONSE = {
  value: [
    {
      id: "msg-1",
      subject: "Your booking confirmation",
      receivedDateTime: "2024-06-15T09:00:00Z",
      from: { emailAddress: { address: "noreply@lufthansa.com" } },
      body: { content: "Buchungsnummer: 9F3K7Q\nFlugnummer: LH456\n" },
    },
  ],
};

function mockFetchOnce(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OutlookAdapter", () => {
  it("maps Graph messages to the internal EmailMessage shape", async () => {
    mockFetchOnce(GRAPH_RESPONSE);
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.truncated).toBe(false);
      expect(result.value.messages).toHaveLength(1);
      expect(result.value.messages[0]?.from).toBe("noreply@lufthansa.com");
      expect(result.value.messages[0]?.bodyText).toContain("Buchungsnummer: 9F3K7Q");
    }
  });

  it("adds a receivedDateTime le clause to the filter when untilUtc is given", async () => {
    const fetchMock = mockFetchOnce({ value: [] });
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    await adapter.listRecentMessages({ sinceUtc: "2024-02-01T00:00:00.000Z", untilUtc: "2024-03-31T23:59:59.000Z" });

    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const filter = requestedUrl.searchParams.get("$filter");
    expect(filter).toContain("receivedDateTime ge 2024-02-01T00:00:00.000Z");
    expect(filter).toContain("receivedDateTime le 2024-03-31T23:59:59.000Z");
  });

  it("follows @odata.nextLink across multiple pages instead of stopping at the first page", async () => {
    const page1 = {
      value: [{ id: "m1", subject: "s1", receivedDateTime: "2024-06-15T09:00:00Z" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2",
    };
    const page2 = {
      value: [{ id: "m2", subject: "s2", receivedDateTime: "2024-06-16T09:00:00Z" }],
    };

    const fetchMock = vi.fn((url: string | URL) => {
      const isPage2 = String(url).includes("skiptoken=page2");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(isPage2 ? page2 : page1),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OutlookAdapter(async () => "fake-access-token");
    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.truncated).toBe(false);
      expect(result.value.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2); // proves it actually followed the next link
  });

  it("marks truncated=true when the message cap is hit but @odata.nextLink still exists", async () => {
    const page1 = {
      value: [{ id: "m1", subject: "s1", receivedDateTime: "2024-06-15T09:00:00Z" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2",
    };

    const fetchMock = vi.fn((url: string | URL) => {
      if (String(url).includes("skiptoken=page2")) {
        throw new Error("should not fetch page 2 once the cap is hit");
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(page1) });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Cap of 1 — the first page already meets it.
    const adapter = new OutlookAdapter(async () => "fake-access-token", 1);
    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.truncated).toBe(true);
      expect(result.value.messages.map((m) => m.id)).toEqual(["m1"]);
    }
  });

  it("returns an empty array when there are no messages", async () => {
    mockFetchOnce({ value: [] });
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result).toEqual({ ok: true, value: { messages: [], truncated: false } });
  });

  it("handles a message with no from address rather than crashing", async () => {
    mockFetchOnce({ value: [{ id: "m1", subject: "s", receivedDateTime: "2024-06-15T09:00:00Z" }] });
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages[0]?.from).toBe("");
      expect(result.value.messages[0]?.bodyText).toBe("");
    }
  });

  it("returns a typed auth_error on HTTP 401", async () => {
    mockFetchOnce({}, 401);
    const adapter = new OutlookAdapter(async () => "expired-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("auth_error");
    }
  });

  it("returns a typed rate_limited error on HTTP 429", async () => {
    mockFetchOnce({}, 429);
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("rate_limited");
    }
  });

  it("returns a typed upstream_error on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });
});

describe("OutlookAdapter — attachments", () => {
  const MESSAGE_WITH_PDF = {
    id: "msg-pdf",
    subject: "Your trip is confirmed",
    receivedDateTime: "2024-06-15T09:00:00Z",
    from: { emailAddress: { address: "noreply@mytrip.com" } },
    body: { content: "see attached" },
    attachments: [{ name: "Receipt_1119-971-928.pdf", contentType: "application/pdf" }],
  };

  it("surfaces attachment metadata when listing messages", async () => {
    mockFetchOnce({ value: [MESSAGE_WITH_PDF] });
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages[0]?.attachments).toEqual([
        { filename: "Receipt_1119-971-928.pdf", mimeType: "application/pdf" },
      ]);
    }
  });

  it("extracts PDF text via getAttachmentText", async () => {
    mockFetchOnce({
      value: [
        {
          name: "Receipt_1119-971-928.pdf",
          contentType: "application/pdf",
          contentBytes: Buffer.from("fake pdf bytes").toString("base64"),
        },
      ],
    });
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.getAttachmentText("msg-pdf", "Receipt_1119-971-928.pdf");

    expect(result).toEqual({ ok: true, value: "Turkish Airlines • TK1867\nTurkish Airlines • TK57" });
  });

  it("returns not_found for a nonexistent attachment filename", async () => {
    mockFetchOnce({ value: [] });
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.getAttachmentText("msg-pdf", "does-not-exist.pdf");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("returns unsupported_attachment for a non-PDF, non-text attachment", async () => {
    mockFetchOnce({
      value: [
        {
          name: "photo.png",
          contentType: "image/png",
          contentBytes: Buffer.from("fake png bytes").toString("base64"),
        },
      ],
    });
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.getAttachmentText("msg-pdf", "photo.png");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("unsupported_attachment");
    }
  });
});

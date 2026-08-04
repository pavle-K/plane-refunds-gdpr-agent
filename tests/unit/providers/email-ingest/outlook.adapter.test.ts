import { describe, it, expect, afterEach, vi } from "vitest";
import { OutlookAdapter } from "../../../../src/providers/email-ingest/outlook.adapter.js";

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
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
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
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.from).toBe("noreply@lufthansa.com");
      expect(result.value[0]?.bodyText).toContain("Buchungsnummer: 9F3K7Q");
    }
  });

  it("returns an empty array when there are no messages", async () => {
    mockFetchOnce({ value: [] });
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("handles a message with no from address rather than crashing", async () => {
    mockFetchOnce({ value: [{ id: "m1", subject: "s", receivedDateTime: "2024-06-15T09:00:00Z" }] });
    const adapter = new OutlookAdapter(async () => "fake-access-token");

    const result = await adapter.listRecentMessages({ sinceUtc: "2024-06-01T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.from).toBe("");
      expect(result.value[0]?.bodyText).toBe("");
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

import { describe, it, expect, afterEach, vi } from "vitest";
import { PostmarkEmailSendAdapter } from "../../../../src/providers/email-send/postmark.adapter.js";

const EMAIL = { to: "claims@airline.example", from: "user@example.com", subject: "Claim", textBody: "body" };

function mockFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PostmarkEmailSendAdapter", () => {
  it("maps a successful send response", async () => {
    mockFetchOnce({ MessageID: "abc-123", SubmittedAt: "2024-06-15T10:00:00.000Z", ErrorCode: 0, Message: "OK" });
    const adapter = new PostmarkEmailSendAdapter("fake-token");

    const result = await adapter.send(EMAIL);

    expect(result).toEqual({
      ok: true,
      value: { messageId: "abc-123", sentAtUtc: "2024-06-15T10:00:00.000Z" },
    });
  });

  it("returns upstream_error when Postmark reports an application-level error", async () => {
    mockFetchOnce({ MessageID: "", SubmittedAt: "", ErrorCode: 300, Message: "Invalid email address" });
    const adapter = new PostmarkEmailSendAdapter("fake-token");

    const result = await adapter.send(EMAIL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });

  it("returns auth_error on HTTP 401", async () => {
    mockFetchOnce({}, 401);
    const adapter = new PostmarkEmailSendAdapter("bad-token");

    const result = await adapter.send(EMAIL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("auth_error");
    }
  });

  it("returns rate_limited on HTTP 429", async () => {
    mockFetchOnce({}, 429);
    const adapter = new PostmarkEmailSendAdapter("fake-token");

    const result = await adapter.send(EMAIL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("rate_limited");
    }
  });

  it("returns upstream_error on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const adapter = new PostmarkEmailSendAdapter("fake-token");

    const result = await adapter.send(EMAIL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });
});

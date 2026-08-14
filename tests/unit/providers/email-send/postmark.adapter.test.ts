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

  it("base64-encodes attachments into Postmark's Attachments array", async () => {
    const calls: { body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        calls.push({ body: init.body });
        return {
          status: 200,
          ok: true,
          json: async () => ({ ErrorCode: 0, MessageID: "m-1", SubmittedAt: "2026-08-14T00:00:00Z" }),
        };
      }),
    );

    const adapter = new PostmarkEmailSendAdapter("token");
    const result = await adapter.send({
      to: "jane@example.test",
      from: "claims@refunds.test",
      subject: "Your claim form",
      textBody: "Attached.",
      attachments: [{ filename: "claim.pdf", content: Buffer.from("%PDF-1.7"), contentType: "application/pdf" }],
    });

    expect(result.ok).toBe(true);
    const body = JSON.parse(calls[0]!.body) as { Attachments: { Name: string; Content: string; ContentType: string }[] };
    expect(body.Attachments).toHaveLength(1);
    expect(body.Attachments[0]?.Name).toBe("claim.pdf");
    expect(body.Attachments[0]?.ContentType).toBe("application/pdf");
    expect(Buffer.from(body.Attachments[0]!.Content, "base64").toString()).toBe("%PDF-1.7");
  });

  it("omits the Attachments key entirely when there are none", async () => {
    const calls: { body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        calls.push({ body: init.body });
        return {
          status: 200,
          ok: true,
          json: async () => ({ ErrorCode: 0, MessageID: "m-1", SubmittedAt: "2026-08-14T00:00:00Z" }),
        };
      }),
    );

    await new PostmarkEmailSendAdapter("token").send({
      to: "a@example.test",
      from: "b@example.test",
      subject: "s",
      textBody: "t",
    });

    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty("Attachments");
  });

  it("refuses an oversized attachment rather than letting Postmark reject it", async () => {
    // Named here, the failure points at the real cause; upstream it arrives as
    // an opaque error while a user is waiting on a document.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await new PostmarkEmailSendAdapter("token").send({
      to: "a@example.test",
      from: "b@example.test",
      subject: "s",
      textBody: "t",
      attachments: [{ filename: "big.pdf", content: Buffer.alloc(9 * 1024 * 1024), contentType: "application/pdf" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("10MB");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

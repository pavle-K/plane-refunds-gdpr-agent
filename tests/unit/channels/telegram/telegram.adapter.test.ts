import { describe, it, expect, afterEach, vi } from "vitest";
import { TelegramAdapter } from "../../../../src/channels/telegram/telegram.adapter.js";

function mockFetchOnce(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TelegramAdapter", () => {
  it("posts chat_id and text to the sendMessage endpoint", async () => {
    const fetchMock = mockFetchOnce({ ok: true, result: {} });
    const adapter = new TelegramAdapter("bot-token");

    const result = await adapter.sendMessage("42", "hello");

    expect(result).toEqual({ ok: true, value: undefined });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: "42", text: "hello" });
  });

  it("strips Markdown link syntax down to the bare URL before sending (no parse_mode is set, so it would otherwise show as broken literal text)", async () => {
    const fetchMock = mockFetchOnce({ ok: true, result: {} });
    const adapter = new TelegramAdapter("bot-token");

    await adapter.sendMessage("42", "Click [here](https://example.com/oauth/gmail/callback?state=abc) to connect.");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "42",
      text: "Click https://example.com/oauth/gmail/callback?state=abc to connect.",
    });
  });

  it("leaves an already-bare URL and ordinary text untouched", async () => {
    const fetchMock = mockFetchOnce({ ok: true, result: {} });
    const adapter = new TelegramAdapter("bot-token");

    await adapter.sendMessage("42", "Here you go: https://example.com/callback?a=1&b=2 — expires in 15 minutes.");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "42",
      text: "Here you go: https://example.com/callback?a=1&b=2 — expires in 15 minutes.",
    });
  });

  it("maps a 401/403 to an auth_error", async () => {
    mockFetchOnce({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    const adapter = new TelegramAdapter("bad-token");

    const result = await adapter.sendMessage("42", "hi");

    expect(result).toEqual({ ok: false, error: { type: "auth_error", message: "Telegram rejected the bot token" } });
  });

  it("maps a 429 to a rate_limited error", async () => {
    mockFetchOnce({ ok: false, error_code: 429, description: "Too Many Requests" }, 429);
    const adapter = new TelegramAdapter("token");

    const result = await adapter.sendMessage("42", "hi");

    expect(result).toEqual({ ok: false, error: { type: "rate_limited", message: "Telegram rate-limited the request" } });
  });

  it("maps a body-level ok:false to an upstream_error, even on HTTP 200", async () => {
    mockFetchOnce({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 200);
    const adapter = new TelegramAdapter("token");

    const result = await adapter.sendMessage("999", "hi");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
      expect(result.error.message).toMatch(/chat not found/);
    }
  });

  it("returns an upstream_error on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const adapter = new TelegramAdapter("token");

    const result = await adapter.sendMessage("42", "hi");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });

  it("sends a document as multipart/form-data, not the JSON body sendMessage uses", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: unknown }) => {
        calls.push({ url, body: init.body });
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      }),
    );

    const result = await new TelegramAdapter("token").sendDocument!(
      "12345",
      { filename: "claim.pdf", content: Buffer.from("%PDF-1.7"), contentType: "application/pdf" },
      "Your claim form",
    );

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain("/sendDocument");
    expect(calls[0]?.body).toBeInstanceOf(FormData);

    const form = calls[0]?.body as FormData;
    expect(form.get("chat_id")).toBe("12345");
    expect(form.get("caption")).toBe("Your claim form");
    const file = form.get("document") as File;
    expect(file.name).toBe("claim.pdf");
    expect(file.type).toBe("application/pdf");
    expect(await file.text()).toBe("%PDF-1.7");
  });

  it("strips markdown links out of a caption, same as message text", async () => {
    // No parse_mode is set on either call, so a wrapped link renders as literal
    // brackets rather than something clickable.
    const calls: { body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: unknown }) => {
        calls.push({ body: init.body });
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      }),
    );

    await new TelegramAdapter("token").sendDocument!(
      "12345",
      { filename: "claim.pdf", content: Buffer.from("x"), contentType: "application/pdf" },
      "See [their form](https://example.test/claim)",
    );

    expect((calls[0]?.body as FormData).get("caption")).toBe("See https://example.test/claim");
  });

  it("maps a document send failure the same way a message send failure is mapped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 429, ok: false, json: async () => ({ ok: false }) })));

    const result = await new TelegramAdapter("token").sendDocument!("12345", {
      filename: "claim.pdf",
      content: Buffer.from("x"),
      contentType: "application/pdf",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("rate_limited");
  });
});

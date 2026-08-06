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
});

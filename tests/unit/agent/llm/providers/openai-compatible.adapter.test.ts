import { describe, it, expect, afterEach, vi } from "vitest";
import { OpenAiCompatibleLlmClient } from "../../../../../src/agent/llm/providers/openai-compatible.adapter.js";
import { LlmRateLimitedError } from "../../../../../src/agent/llm/llm.port.js";

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

function mockFetchSequence(bodies: unknown[]) {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAiCompatibleLlmClient", () => {
  describe("complete", () => {
    it("returns the message content on success", async () => {
      mockFetchOnce({ choices: [{ message: { content: "hello" } }] });
      const client = new OpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com/v1", apiKey: "key", model: "m" });

      const result = await client.complete({ system: "s", prompt: "p" });

      expect(result).toBe("hello");
    });

    it("sends an authorization header only when apiKey is provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: "hi" } }] }),
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new OpenAiCompatibleLlmClient({ baseUrl: "http://localhost:11434/v1", model: "qwen3:8b" });

      await client.complete({ system: "s", prompt: "p" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["authorization"]).toBeUndefined();
    });

    it("throws on a non-ok response", async () => {
      mockFetchOnce({ error: "bad request" }, 400);
      const client = new OpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com/v1", apiKey: "key", model: "m" });

      await expect(client.complete({ system: "s", prompt: "p" })).rejects.toThrow(/400/);
    });

    it("throws when the response has no text content", async () => {
      mockFetchOnce({ choices: [{ message: { content: null } }] });
      const client = new OpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com/v1", apiKey: "key", model: "m" });

      await expect(client.complete({ system: "s", prompt: "p" })).rejects.toThrow(/no text content/);
    });

    it("throws LlmRateLimitedError with the Retry-After header value on a 429", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === "retry-after" ? "12" : null) },
        text: () => Promise.resolve("rate limited"),
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new OpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com/v1", apiKey: "key", model: "m" });

      const error = (await client.complete({ system: "s", prompt: "p" }).catch((e: unknown) => e)) as LlmRateLimitedError;

      expect(error).toBeInstanceOf(LlmRateLimitedError);
      expect(error.retryAfterSeconds).toBe(12);
    });

    it("throws LlmRateLimitedError with no retry hint when there's no Retry-After header", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: () => Promise.resolve("rate limited"),
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new OpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com/v1", apiKey: "key", model: "m" });

      const error = (await client.complete({ system: "s", prompt: "p" }).catch((e: unknown) => e)) as LlmRateLimitedError;

      expect(error).toBeInstanceOf(LlmRateLimitedError);
      expect(error.retryAfterSeconds).toBeUndefined();
    });
  });

  describe("completeWithTools", () => {
    it("runs the requested tool then returns the final text", async () => {
      mockFetchSequence([
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"x":1}' } }],
              },
            },
          ],
        },
        { choices: [{ message: { content: "done" } }] },
      ]);
      const client = new OpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com/v1", apiKey: "key", model: "m" });
      const onToolCall = vi.fn().mockResolvedValue("tool result");

      const result = await client.completeWithTools({
        system: "s",
        prompt: "p",
        tools: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }],
        onToolCall,
      });

      expect(result).toBe("done");
      expect(onToolCall).toHaveBeenCalledWith({ name: "lookup", input: { x: 1 } });
    });

    it("includes prior conversation history ahead of the current prompt", async () => {
      const fetchMock = mockFetchOnce({ choices: [{ message: { content: "done" } }] });
      const client = new OpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com/v1", apiKey: "key", model: "m" });

      await client.completeWithTools({
        system: "s",
        prompt: "second question",
        tools: [],
        onToolCall: vi.fn(),
        history: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
        ],
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages).toEqual([
        { role: "system", content: "s" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ]);
    });

    it("throws once maxIterations is exhausted without a final response", async () => {
      mockFetchOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "loop", arguments: "{}" } }],
            },
          },
        ],
      });
      const client = new OpenAiCompatibleLlmClient({ baseUrl: "https://api.example.com/v1", apiKey: "key", model: "m" });

      await expect(
        client.completeWithTools({
          system: "s",
          prompt: "p",
          tools: [{ name: "loop", description: "d", inputSchema: { type: "object" } }],
          onToolCall: vi.fn().mockResolvedValue("result"),
          maxIterations: 2,
        }),
      ).rejects.toThrow(/did not converge/);
    });
  });
});

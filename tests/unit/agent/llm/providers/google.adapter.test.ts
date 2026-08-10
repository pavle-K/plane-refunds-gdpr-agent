import { describe, it, expect, afterEach, vi } from "vitest";
import { GoogleLlmClient } from "../../../../../src/agent/llm/providers/google.adapter.js";

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

describe("GoogleLlmClient", () => {
  describe("complete", () => {
    it("returns the text part on success", async () => {
      mockFetchOnce({ candidates: [{ content: { parts: [{ text: "hello" }] } }] });
      const client = new GoogleLlmClient("key", "gemini-3-pro");

      const result = await client.complete({ system: "s", prompt: "p" });

      expect(result).toBe("hello");
    });

    it("throws on a non-ok response", async () => {
      mockFetchOnce({ error: "bad request" }, 400);
      const client = new GoogleLlmClient("key", "gemini-3-pro");

      await expect(client.complete({ system: "s", prompt: "p" })).rejects.toThrow(/400/);
    });

    it("throws when the response has no text part", async () => {
      mockFetchOnce({ candidates: [{ content: { parts: [{ functionCall: { name: "x", args: {} } }] } }] });
      const client = new GoogleLlmClient("key", "gemini-3-pro");

      await expect(client.complete({ system: "s", prompt: "p" })).rejects.toThrow(/no text part/);
    });
  });

  describe("completeWithTools", () => {
    it("runs the requested function call then returns the final text", async () => {
      mockFetchSequence([
        { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { x: 1 } } }] } }] },
        { candidates: [{ content: { parts: [{ text: "done" }] } }] },
      ]);
      const client = new GoogleLlmClient("key", "gemini-3-pro");
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

    it("sends the function result back with role 'user', not 'function' (Gemini has no such role)", async () => {
      const fetchMock = mockFetchSequence([
        { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { x: 1 } } }] } }] },
        { candidates: [{ content: { parts: [{ text: "done" }] } }] },
      ]);
      const client = new GoogleLlmClient("key", "gemini-3-pro");

      await client.completeWithTools({
        system: "s",
        prompt: "p",
        tools: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }],
        onToolCall: vi.fn().mockResolvedValue("tool result"),
      });

      const secondCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(secondCall[1].body as string) as { contents: Array<{ role: string }> };
      const functionResultTurn = body.contents[body.contents.length - 1]!;
      expect(functionResultTurn.role).toBe("user");
    });

    it("includes prior conversation history ahead of the current prompt, mapping assistant to model", async () => {
      const fetchMock = mockFetchOnce({ candidates: [{ content: { parts: [{ text: "done" }] } }] });
      const client = new GoogleLlmClient("key", "gemini-3-pro");

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
      const body = JSON.parse(init.body as string) as { contents: Array<{ role: string; parts: Array<{ text: string }> }> };
      expect(body.contents).toEqual([
        { role: "user", parts: [{ text: "first question" }] },
        { role: "model", parts: [{ text: "first answer" }] },
        { role: "user", parts: [{ text: "second question" }] },
      ]);
    });

    it("throws once maxIterations is exhausted without a final response", async () => {
      mockFetchOnce({ candidates: [{ content: { parts: [{ functionCall: { name: "loop", args: {} } }] } }] });
      const client = new GoogleLlmClient("key", "gemini-3-pro");

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

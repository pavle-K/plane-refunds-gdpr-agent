import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

/** Mocks the whole SDK rather than stubbing fetch — the adapter talks to it
 * through the SDK client, not raw HTTP, unlike the Gemini/OpenAI-compatible
 * adapters. instanceof checks against Anthropic.APIError in the adapter code
 * work correctly here because both the adapter and this test import the same
 * mocked module. */
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    constructor(
      public readonly status: number,
      public readonly headers: { get: (name: string) => string | null },
      message: string,
    ) {
      super(message);
    }
  }
  class MockAnthropicClient {
    messages = { create: mockCreate };
  }
  return { default: Object.assign(MockAnthropicClient, { APIError }) };
});

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlmClient } from "../../../../../src/agent/llm/providers/anthropic.adapter.js";
import { LlmRateLimitedError } from "../../../../../src/agent/llm/llm.port.js";

beforeEach(() => {
  mockCreate.mockReset();
});

describe("AnthropicLlmClient", () => {
  describe("complete", () => {
    it("returns the text block on success", async () => {
      mockCreate.mockResolvedValue({ content: [{ type: "text", text: "hello" }] });
      const client = new AnthropicLlmClient("key", "model");

      const result = await client.complete({ system: "s", prompt: "p" });

      expect(result).toBe("hello");
    });

    it("throws LlmRateLimitedError with the Retry-After header on a 429 APIError", async () => {
      const headers = { get: (name: string) => (name === "retry-after" ? "5" : null) };
      mockCreate.mockRejectedValue(
        new (Anthropic as unknown as { APIError: new (...a: unknown[]) => Error }).APIError(429, headers, "rate limited"),
      );
      const client = new AnthropicLlmClient("key", "model");

      const error = (await client.complete({ system: "s", prompt: "p" }).catch((e: unknown) => e)) as LlmRateLimitedError;

      expect(error).toBeInstanceOf(LlmRateLimitedError);
      expect(error.provider).toBe("Anthropic");
      expect(error.retryAfterSeconds).toBe(5);
    });

    it("passes through non-rate-limit errors unchanged", async () => {
      mockCreate.mockRejectedValue(new Error("boom"));
      const client = new AnthropicLlmClient("key", "model");

      await expect(client.complete({ system: "s", prompt: "p" })).rejects.toThrow("boom");
    });
  });

  describe("completeWithTools", () => {
    it("runs the requested tool then returns the final text", async () => {
      mockCreate
        .mockResolvedValueOnce({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { x: 1 } }],
        })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "done" }] });
      const client = new AnthropicLlmClient("key", "model");
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
  });
});

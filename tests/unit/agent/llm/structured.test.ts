import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { callStructured, callStructuredWithTools, StructuredLlmOutputError } from "../../../../src/agent/llm/structured.js";
import { FakeLlmClient } from "../../../../src/agent/llm/fake.js";

const schema = z.object({ eligible: z.boolean(), confidence: z.number() });

describe("callStructured", () => {
  it("parses and validates a clean JSON response", async () => {
    const client = new FakeLlmClient();
    client.enqueueJson({ eligible: true, confidence: 0.9 });

    const result = await callStructured(client, { system: "sys", prompt: "p", schema });
    expect(result).toEqual({ eligible: true, confidence: 0.9 });
  });

  it("strips a markdown JSON code fence before parsing", async () => {
    const client = new FakeLlmClient();
    client.enqueueResponse('```json\n{"eligible": false, "confidence": 0.2}\n```');

    const result = await callStructured(client, { system: "sys", prompt: "p", schema });
    expect(result).toEqual({ eligible: false, confidence: 0.2 });
  });

  it("throws StructuredLlmOutputError on malformed JSON, never returns partial data", async () => {
    const client = new FakeLlmClient();
    client.enqueueResponse("not json at all");

    await expect(callStructured(client, { system: "sys", prompt: "p", schema })).rejects.toThrow(
      StructuredLlmOutputError,
    );
  });

  it("throws StructuredLlmOutputError when the JSON doesn't match the schema", async () => {
    const client = new FakeLlmClient();
    client.enqueueJson({ eligible: "yes" }); // wrong type, missing field

    await expect(callStructured(client, { system: "sys", prompt: "p", schema })).rejects.toThrow(
      StructuredLlmOutputError,
    );
  });

  it("appends a JSON-only instruction to the system prompt", async () => {
    const client = new FakeLlmClient();
    client.enqueueJson({ eligible: true, confidence: 1 });

    await callStructured(client, { system: "base instructions", prompt: "p", schema });

    expect(client.calls[0]?.system).toContain("base instructions");
    expect(client.calls[0]?.system).toContain("ONLY valid JSON");
  });
});

describe("callStructuredWithTools", () => {
  it("returns the final response directly when no tool is called", async () => {
    const client = new FakeLlmClient();
    client.enqueueFinalJson({ eligible: true, confidence: 0.9 });

    const result = await callStructuredWithTools(client, {
      system: "sys",
      prompt: "p",
      schema,
      tools: [],
      onToolCall: async () => "unused",
    });

    expect(result).toEqual({ eligible: true, confidence: 0.9 });
  });

  it("runs the tool loop and validates only the final non-tool-call response", async () => {
    const client = new FakeLlmClient();
    client.enqueueToolCall({ name: "lookup", input: { id: "abc" } });
    client.enqueueFinalJson({ eligible: false, confidence: 0.1 });

    const onToolCall = vi.fn().mockResolvedValue(JSON.stringify({ found: true }));
    const result = await callStructuredWithTools(client, {
      system: "sys",
      prompt: "p",
      schema,
      tools: [{ name: "lookup", description: "looks something up", inputSchema: { type: "object" } }],
      onToolCall,
    });

    expect(result).toEqual({ eligible: false, confidence: 0.1 });
    expect(onToolCall).toHaveBeenCalledWith({ name: "lookup", input: { id: "abc" } });
  });

  it("throws StructuredLlmOutputError when the final response fails schema validation", async () => {
    const client = new FakeLlmClient();
    client.enqueueFinalJson({ eligible: "yes" });

    await expect(
      callStructuredWithTools(client, { system: "sys", prompt: "p", schema, tools: [], onToolCall: async () => "" }),
    ).rejects.toThrow(StructuredLlmOutputError);
  });
});

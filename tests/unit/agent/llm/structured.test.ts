import { describe, it, expect } from "vitest";
import { z } from "zod";
import { callStructured } from "../../../../src/agent/llm/structured.js";
import { FakeChatModel } from "../../../../src/agent/llm/fake-chat-model.js";

const schema = z.object({ eligible: z.boolean(), confidence: z.number() });

describe("callStructured", () => {
  it("parses and validates a clean JSON response", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalJson({ eligible: true, confidence: 0.9 });

    const result = await callStructured(model, { system: "sys", prompt: "p", schema });
    expect(result).toEqual({ eligible: true, confidence: 0.9 });
  });

  it("throws when the response doesn't match the schema, never returns partial data", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalJson({ eligible: "yes" }); // wrong type, missing field

    await expect(callStructured(model, { system: "sys", prompt: "p", schema })).rejects.toThrow();
  });

  it("sends the given system and prompt straight through — no hidden prompt engineering", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalJson({ eligible: true, confidence: 1 });

    await callStructured(model, { system: "base instructions", prompt: "p", schema });

    expect(model.calls).toEqual([{ system: "base instructions", prompt: "p" }]);
  });
});

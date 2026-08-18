import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createAgent, tool } from "langchain";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { FakeChatModel } from "../../../../src/agent/llm/fake-chat-model.js";

describe("FakeChatModel", () => {
  it("returns a scripted final text response", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalText("hello there");

    const result = await model.invoke([new HumanMessage("hi")]);
    expect(result.content).toBe("hello there");
  });

  it("returns a scripted JSON response via enqueueFinalJson", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalJson({ eligible: true, confidence: 0.9 });

    const result = await model.invoke([new HumanMessage("hi")]);
    expect(JSON.parse(result.content as string)).toEqual({ eligible: true, confidence: 0.9 });
  });

  it("returns a scripted tool call with tool_calls populated", async () => {
    const model = new FakeChatModel();
    model.enqueueToolCall({ name: "get_claim_status", args: { threadId: "claim-1" } });

    const result = await model.invoke([new HumanMessage("check status")]);
    expect(result.tool_calls).toEqual([{ name: "get_claim_status", args: { threadId: "claim-1" }, id: "fake-call-0" }]);
    expect(model.toolCallsMade).toEqual([{ name: "get_claim_status", args: { threadId: "claim-1" } }]);
  });

  it("supports parallel tool calls in a single scripted step", async () => {
    const model = new FakeChatModel();
    model.enqueueToolCall(
      { name: "get_email_connection_status", args: {} },
      { name: "list_supported_airlines", args: {} },
    );

    const result = await model.invoke([new HumanMessage("go")]);
    expect(result.tool_calls?.map((c) => c.name)).toEqual(["get_email_connection_status", "list_supported_airlines"]);
  });

  it("plays back multiple scripted steps in order across separate invocations", async () => {
    const model = new FakeChatModel();
    model.enqueueToolCall({ name: "get_claim_status", args: {} });
    model.enqueueFinalText("done");

    const first = await model.invoke([new HumanMessage("go")]);
    expect(first.tool_calls?.[0]?.name).toBe("get_claim_status");

    const second = await model.invoke([new HumanMessage("go")]);
    expect(second.content).toBe("done");
  });

  it("throws a clear error when invoked with nothing scripted — never silently returns a real-looking response", async () => {
    const model = new FakeChatModel();
    await expect(model.invoke([new HumanMessage("hi")])).rejects.toThrow("no more scripted responses queued");
  });

  it("records every invocation's messages in order", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalText("a");
    model.enqueueFinalText("b");

    await model.invoke([new HumanMessage("first")]);
    await model.invoke([new HumanMessage("second")]);

    expect(model.invocations).toHaveLength(2);
    expect((model.invocations[0]?.[0]?.content as string)).toBe("first");
    expect((model.invocations[1]?.[0]?.content as string)).toBe("second");
  });

  it("supports bindTools — behavior stays fully scripted regardless of the tool schemas passed", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalText("bound ok");

    const bound = model.bindTools([{ name: "some_tool", description: "d", schema: {} }]);
    const result = await bound.invoke([new HumanMessage("hi")]);
    expect(result.content).toBe("bound ok");
  });
});

describe("FakeChatModel.withStructuredOutput", () => {
  const schema = z.object({ eligible: z.boolean(), confidence: z.number() });

  it("returns a scripted final JSON response, validated against the schema", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalJson({ eligible: true, confidence: 0.9 });

    const result = await model.withStructuredOutput(schema).invoke([new SystemMessage("sys"), new HumanMessage("p")]);
    expect(result).toEqual({ eligible: true, confidence: 0.9 });
  });

  it("throws when the scripted JSON doesn't match the schema — never returns unvalidated data", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalJson({ eligible: "yes" }); // wrong type, missing field

    await expect(
      model.withStructuredOutput(schema).invoke([new SystemMessage("sys"), new HumanMessage("p")]),
    ).rejects.toThrow();
  });

  it("records the system+prompt pair in .calls", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalJson({ eligible: true, confidence: 1 });

    await model.withStructuredOutput(schema).invoke([new SystemMessage("base instructions"), new HumanMessage("p")]);

    expect(model.calls).toEqual([{ system: "base instructions", prompt: "p" }]);
  });

  it("throws a clear error if a tool-call step was scripted instead of a final response", async () => {
    const model = new FakeChatModel();
    model.enqueueToolCall({ name: "lookup", args: {} });

    await expect(
      model.withStructuredOutput(schema).invoke([new SystemMessage("sys"), new HumanMessage("p")]),
    ).rejects.toThrow("don't support a tool loop");
  });
});

describe("FakeChatModel.enqueueStructuredToolCall (createAgent responseFormat)", () => {
  it("resolves createAgent's synthetic extract-N tool name dynamically, not a hardcoded guess", async () => {
    const model = new FakeChatModel();
    model.enqueueStructuredToolCall({ booking: { bookingReference: "9F3K7Q" } });

    const agent = createAgent({
      model,
      tools: [],
      systemPrompt: "test",
      responseFormat: z.object({ booking: z.object({ bookingReference: z.string() }).nullable() }),
    });

    const result = await agent.invoke({ messages: [new HumanMessage("go")] });
    expect(result.structuredResponse).toEqual({ booking: { bookingReference: "9F3K7Q" } });
  });

  it("still resolves correctly when a real tool call happens first — the synthetic name increments per model call", async () => {
    const model = new FakeChatModel();
    model.enqueueToolCall({ name: "get_attachment_text", args: { filename: "Receipt.pdf" } });
    model.enqueueStructuredToolCall({ booking: { bookingReference: "9F3K7Q" } });

    const getAttachmentText = tool(async ({ filename }: { filename: string }) => ({ text: `contents of ${filename}` }), {
      name: "get_attachment_text",
      description: "fetch attachment text",
      schema: z.object({ filename: z.string() }),
    });

    const agent = createAgent({
      model,
      tools: [getAttachmentText],
      systemPrompt: "test",
      responseFormat: z.object({ booking: z.object({ bookingReference: z.string() }).nullable() }),
    });

    const result = await agent.invoke({ messages: [new HumanMessage("go")] });
    expect(result.structuredResponse).toEqual({ booking: { bookingReference: "9F3K7Q" } });
    // The exact "extract-N" number isn't stable across a whole test run (it's a
    // counter shared by every createAgent responseFormat call in the process,
    // not scoped per agent) — only the pattern and the relative order matter.
    const [first, second] = model.toolCallsMade.map((c) => c.name);
    expect(first).toBe("get_attachment_text");
    expect(second).toMatch(/^extract-\d+$/);
  });
});

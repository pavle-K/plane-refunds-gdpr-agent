import { describe, it, expect } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
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

  it("supports bindTools without inspecting the schemas — behavior stays fully scripted", async () => {
    const model = new FakeChatModel();
    model.enqueueFinalText("bound ok");

    const bound = model.bindTools([{ name: "some_tool", description: "d", schema: {} }]);
    const result = await bound.invoke([new HumanMessage("hi")]);
    expect(result.content).toBe("bound ok");
  });
});

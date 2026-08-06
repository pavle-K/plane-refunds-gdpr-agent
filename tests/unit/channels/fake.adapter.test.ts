import { describe, it, expect } from "vitest";
import { FakeChannelAdapter } from "../../../src/channels/fake.adapter.js";
import { err } from "../../../src/lib/result.js";

describe("FakeChannelAdapter", () => {
  it("records the sent message instead of sending it", async () => {
    const adapter = new FakeChannelAdapter();
    await adapter.sendMessage("user-1", "hello");
    expect(adapter.sentMessages).toEqual([{ externalUserId: "user-1", text: "hello" }]);
  });

  it("can be queued to simulate a failed send", async () => {
    const adapter = new FakeChannelAdapter();
    adapter.queueResult(err({ type: "upstream_error", message: "simulated failure" }));

    const result = await adapter.sendMessage("user-1", "hello");

    expect(result).toEqual(err({ type: "upstream_error", message: "simulated failure" }));
    expect(adapter.sentMessages).toEqual([{ externalUserId: "user-1", text: "hello" }]);
  });
});

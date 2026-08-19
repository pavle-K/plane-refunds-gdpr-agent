import { describe, it, expect } from "vitest";
import { NullChannelAdapter } from "../../../src/channels/null.adapter.js";

describe("NullChannelAdapter", () => {
  it("reports sendMessage as a failed upstream send rather than a silent success", async () => {
    const adapter = new NullChannelAdapter();
    const result = await adapter.sendMessage("session-1", "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });

  it("reports sendDocument as a failed upstream send rather than a silent success", async () => {
    const adapter = new NullChannelAdapter();
    const result = await adapter.sendDocument("session-1", {
      filename: "claim.pdf",
      content: Buffer.from("pdf"),
      contentType: "application/pdf",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });
});

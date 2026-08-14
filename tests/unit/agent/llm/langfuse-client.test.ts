import { describe, it, expect, vi, afterEach } from "vitest";

async function importWith(overrides: {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_HOST?: string;
}) {
  vi.resetModules();
  vi.doMock("../../../../src/config/env.js", () => ({ env: overrides }));
  return import("../../../../src/agent/llm/langfuse-client.js");
}

describe("langfuse client factory", () => {
  afterEach(() => {
    vi.doUnmock("../../../../src/config/env.js");
  });

  it("returns null when no keys are configured — same fallback shape as every other provider", async () => {
    const { getLangfuseClient } = await importWith({});
    expect(getLangfuseClient()).toBeNull();
  });

  it("returns null when only one of the two keys is set", async () => {
    const { getLangfuseClient } = await importWith({ LANGFUSE_PUBLIC_KEY: "pk-x" });
    expect(getLangfuseClient()).toBeNull();
  });

  it("constructs a real client when both keys are present", async () => {
    const { getLangfuseClient } = await importWith({
      LANGFUSE_PUBLIC_KEY: "pk-x",
      LANGFUSE_SECRET_KEY: "sk-x",
    });
    expect(getLangfuseClient()).not.toBeNull();
  });

  it("memoizes — the same instance comes back on a second call", async () => {
    const { getLangfuseClient } = await importWith({
      LANGFUSE_PUBLIC_KEY: "pk-x",
      LANGFUSE_SECRET_KEY: "sk-x",
    });
    expect(getLangfuseClient()).toBe(getLangfuseClient());
  });
});

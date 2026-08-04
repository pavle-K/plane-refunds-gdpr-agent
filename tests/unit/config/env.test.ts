import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("env", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("parses a valid environment", async () => {
    process.env["DATABASE_URL"] = "postgresql://user:pass@host:5432/db";
    process.env["NODE_ENV"] = "development";
    const { env } = await import("../../../src/config/env.js");
    expect(env.DATABASE_URL).toBe("postgresql://user:pass@host:5432/db");
    expect(env.NODE_ENV).toBe("development");
  });

  it("fails fast on a malformed DATABASE_URL", async () => {
    process.env["DATABASE_URL"] = "not-a-postgres-url";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("../../../src/config/env.js")).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("does not require provider keys that are not yet in use", async () => {
    process.env["DATABASE_URL"] = "postgresql://user:pass@host:5432/db";
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["STRIPE_SECRET_KEY"];

    const { env } = await import("../../../src/config/env.js");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });
});

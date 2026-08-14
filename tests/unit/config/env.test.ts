import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// This suite must control process.env completely, independent of whatever the
// developer's real .env file happens to contain — without this, env.ts's own
// dotenv.config() call re-fills any var a test deletes, straight from disk.
vi.mock("dotenv", () => ({ config: vi.fn() }));

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

  const VALID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  function setValidProductionSecrets() {
    process.env["NODE_ENV"] = "production";
    process.env["TELEGRAM_WEBHOOK_SECRET"] = "a-real-webhook-secret";
    process.env["PUBLIC_URL"] = "https://claims.example.com";
    process.env["TOKEN_ENCRYPTION_KEY"] = VALID_TOKEN_ENCRYPTION_KEY;
  }

  it("boots in production when TELEGRAM_WEBHOOK_SECRET, PUBLIC_URL, and TOKEN_ENCRYPTION_KEY are all set", async () => {
    setValidProductionSecrets();
    const { env } = await import("../../../src/config/env.js");
    expect(env.NODE_ENV).toBe("production");
    expect(env.PUBLIC_URL).toBe("https://claims.example.com");
  });

  it.each(["TELEGRAM_WEBHOOK_SECRET", "PUBLIC_URL", "TOKEN_ENCRYPTION_KEY"] as const)(
    "fails to boot in production when %s is missing",
    async (missingKey) => {
      setValidProductionSecrets();
      delete process.env[missingKey];

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(import("../../../src/config/env.js")).rejects.toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes(missingKey))).toBe(true);

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    },
  );

  it("does not require TELEGRAM_WEBHOOK_SECRET, PUBLIC_URL, or TOKEN_ENCRYPTION_KEY outside production", async () => {
    process.env["DATABASE_URL"] = "postgresql://user:pass@host:5432/db";
    process.env["NODE_ENV"] = "development";
    delete process.env["TELEGRAM_WEBHOOK_SECRET"];
    delete process.env["PUBLIC_URL"];
    delete process.env["TOKEN_ENCRYPTION_KEY"];

    const { env } = await import("../../../src/config/env.js");
    expect(env.TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
    expect(env.PUBLIC_URL).toBeUndefined();
    expect(env.TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });
});

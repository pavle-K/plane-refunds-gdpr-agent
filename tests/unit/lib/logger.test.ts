import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The logger reads env.LOG_LEVEL/LOG_FORMAT once at import time (same pattern
 * as env.ts itself), so each test that needs a specific level/format
 * combination re-imports the module fresh via vi.resetModules() rather than
 * mutating a shared singleton — the same approach env.test.ts already uses
 * for testing config parsing.
 */
async function importLoggerWith(overrides: { LOG_LEVEL?: string; LOG_FORMAT?: string; NODE_ENV?: string }) {
  vi.resetModules();
  vi.doMock("../../../src/config/env.js", () => ({
    env: { LOG_LEVEL: "info", NODE_ENV: "test", ...overrides },
  }));
  return import("../../../src/lib/logger.js");
}

describe("logger", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.doUnmock("../../../src/config/env.js");
  });

  function lastLine(spy: ReturnType<typeof vi.spyOn>): string {
    const calls = spy.mock.calls;
    return (calls[calls.length - 1]?.[0] as string) ?? "";
  }

  it("emits a level at or below the configured threshold", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "info", LOG_FORMAT: "json" });
    logger.warn("something recoverable failed");
    expect(JSON.parse(lastLine(stdoutSpy))).toMatchObject({ level: "warn", msg: "something recoverable failed" });
  });

  it("suppresses a level more verbose than the configured threshold", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "info", LOG_FORMAT: "json" });
    logger.debug("tool called", { tool: "start_claim" });
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("proves whether a tool was called — the case this was built for", async () => {
    // At info alone, a turn that calls zero tools is distinguishable from one
    // that calls forget_my_data — no inference from a chat transcript required.
    const { logger } = await importLoggerWith({ LOG_LEVEL: "info", LOG_FORMAT: "json" });
    logger.info("turn completed", { toolCalls: 0 });
    expect(JSON.parse(lastLine(stdoutSpy))).toMatchObject({ toolCalls: 0 });
  });

  it("routes error-level lines to stderr, everything else to stdout", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "debug", LOG_FORMAT: "json" });
    logger.error("tool dispatch threw", { tool: "forget_my_data" });
    logger.info("turn received");

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lastLine(stderrSpy))).toMatchObject({ level: "error" });
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it("redacts known-sensitive keys at any nesting depth, recursively", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "debug", LOG_FORMAT: "json" });
    logger.debug("tool called", {
      tool: "save_passenger_profile",
      input: { fullName: "Jane Doe", iban: "ES9121000418450200051332", bank: { bic: "CAIXESBBXXX" } },
    });

    const record = JSON.parse(lastLine(stdoutSpy)) as { input: { fullName: string; iban: string; bank: { bic: string } } };
    expect(record.input.fullName).toBe("Jane Doe");
    expect(record.input.iban).toBe("[redacted]");
    expect(record.input.bank.bic).toBe("[redacted]");
  });

  it("redacts case-insensitively and inside arrays", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "debug", LOG_FORMAT: "json" });
    logger.debug("batch", { items: [{ IBAN: "x" }, { encryptedAccessToken: "y" }] });

    const record = JSON.parse(lastLine(stdoutSpy)) as { items: { IBAN?: string; encryptedAccessToken?: string }[] };
    expect(record.items[0]?.IBAN).toBe("[redacted]");
    expect(record.items[1]?.encryptedAccessToken).toBe("[redacted]");
  });

  it("does not redact ordinary fields — debug logging stays useful", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "debug", LOG_FORMAT: "json" });
    logger.debug("tool called", { tool: "get_claim_status", threadId: "claim-abc123" });

    const record = JSON.parse(lastLine(stdoutSpy)) as { threadId: string };
    expect(record.threadId).toBe("claim-abc123");
  });

  it("formats as JSON when LOG_FORMAT=json", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "info", LOG_FORMAT: "json" });
    logger.info("turn received", { channel: "telegram" });

    expect(() => JSON.parse(lastLine(stdoutSpy))).not.toThrow();
  });

  it("formats as a readable line when LOG_FORMAT=pretty", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "info", LOG_FORMAT: "pretty" });
    logger.info("turn received", { channel: "telegram" });

    const line = lastLine(stdoutSpy);
    expect(line).toContain("turn received");
    expect(line).toContain("INFO");
    expect(() => JSON.parse(line)).toThrow(); // not a JSON line
  });

  it("defaults level to 'error' under NODE_ENV=test, keeping test output quiet", async () => {
    // vitest sets NODE_ENV=test; without this default every integration test
    // that exercises handleTurn (which now logs through this module) would
    // print info-level lines on every `npm test` run.
    vi.resetModules();
    vi.doMock("../../../src/config/env.js", () => ({ env: { NODE_ENV: "test" } }));
    const { logger } = await import("../../../src/lib/logger.js");

    logger.info("should be suppressed by default under test");
    expect(stdoutSpy).not.toHaveBeenCalled();

    logger.error("should still surface");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("lets an explicit LOG_LEVEL override the NODE_ENV=test default", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "info", NODE_ENV: "test", LOG_FORMAT: "json" });
    logger.info("explicitly requested, should show even under test");
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults format from NODE_ENV when LOG_FORMAT is unset", async () => {
    const dev = await importLoggerWith({ LOG_LEVEL: "info", NODE_ENV: "development" });
    dev.logger.info("x");
    expect(() => JSON.parse(lastLine(stdoutSpy))).toThrow(); // pretty in dev

    const prod = await importLoggerWith({ LOG_LEVEL: "info", NODE_ENV: "production" });
    prod.logger.info("x");
    expect(() => JSON.parse(lastLine(stdoutSpy))).not.toThrow(); // json in prod
  });

  it("merges child context into every subsequent call without repeating it at the call site", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "info", LOG_FORMAT: "json" });
    const turnLog = logger.child({ turnId: "t-1", channel: "telegram" });

    turnLog.info("turn received", { textLength: 12 });
    const record = JSON.parse(lastLine(stdoutSpy)) as { turnId: string; channel: string; textLength: number };

    expect(record.turnId).toBe("t-1");
    expect(record.channel).toBe("telegram");
    expect(record.textLength).toBe(12);
  });

  it("lets a call-site field override child context with the same key", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "info", LOG_FORMAT: "json" });
    const child = logger.child({ scope: "outer" });

    child.info("x", { scope: "inner" });
    const record = JSON.parse(lastLine(stdoutSpy)) as { scope: string };
    expect(record.scope).toBe("inner");
  });

  it("skips serialization work entirely for a suppressed level", async () => {
    const { logger } = await importLoggerWith({ LOG_LEVEL: "error", LOG_FORMAT: "json" });
    const poison = {
      get iban(): string {
        throw new Error("should never be read at a suppressed level");
      },
    };
    expect(() => logger.trace("noisy", poison)).not.toThrow();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

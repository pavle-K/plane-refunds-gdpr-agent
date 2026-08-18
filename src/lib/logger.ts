import { env } from "../config/env.js";

/**
 * Structured logging, configured entirely via LOG_LEVEL/LOG_FORMAT in .env.
 *
 * This exists because there wasn't one. A real incident — an operator LLM
 * appearing to fabricate an entire data-deletion confirmation flow instead of
 * calling `forget_my_data` — turned out to be impossible to prove or disprove
 * from the chat transcript alone: nothing server-side recorded whether the
 * tool was ever called. `onToolCall` (session.ts) was wired to console.log
 * only in the local CLI script; the actual Telegram deployment had zero
 * record of tool calls, and a caught tool-dispatch error was swallowed into a
 * JSON string handed back to the model with no server-side trace at all.
 *
 * Levels, least to most verbose — `error` > `warn` > `info` > `debug` >
 * `trace`. Deliberately NOT the same thing as `src/compliance/audit-log.ts`:
 * the audit log is an append-only, legally-scoped compliance record (human
 * decisions, LLM drafting output, data erasure) that must never be touched by
 * a log-level toggle. This is operational/debug logging — different purpose,
 * different retention expectations, different data.
 *
 * No third-party logging library: this repo already prefers small house-rolled
 * implementations over heavy dependencies for things this shape (see Result,
 * the multi-provider LlmClient abstraction instead of LangChain's model
 * wrappers) — a level-filtered, two-format line logger is well within that.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

export type LogFields = Record<string, unknown>;

/**
 * Keys redacted wherever they appear, at any nesting depth, in logged fields —
 * a pragmatic, key-based default, not a full PII scrubber
 * (`src/compliance/redaction.ts`, still Stage 3, not built). This catches
 * the highest-damage cases (bank details, tokens,
 * secrets) without redacting so aggressively that debug logging stops being
 * useful for its actual purpose — free text like a raw email body or a
 * passenger name is NOT redacted here; keep LOG_LEVEL at "info" in production
 * if that distinction matters for your deployment.
 */
const REDACTED_KEY_PATTERN =
  /^(iban|bic|encryptediban|encryptedbic|accesstoken|refreshtoken|encryptedaccesstoken|encryptedrefreshtoken|password|apikey|api_key|secret|token|authorization|codeverifier)$/i;

const REDACTED = "[redacted]";
const MAX_REDACTION_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (depth >= MAX_REDACTION_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEY_PATTERN.test(key) ? REDACTED : redact(val, depth + 1);
  }
  return out;
}

interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: "\x1b[31m", // red
  warn: "\x1b[33m", // yellow
  info: "\x1b[36m", // cyan
  debug: "\x1b[90m", // grey
  trace: "\x1b[90m", // grey
};
const COLOR_RESET = "\x1b[0m";

function formatPretty(record: LogRecord): string {
  const { ts, level, msg, ...fields } = record;
  const time = ts.slice(11, 23); // HH:MM:SS.mmm — the date is noise in a live terminal
  const color = LEVEL_COLOR[level];
  const label = level.toUpperCase().padEnd(5);
  const rest = Object.keys(fields).length > 0 ? " " + JSON.stringify(fields) : "";
  return `${time} ${color}${label}${COLOR_RESET} ${msg}${rest}`;
}

function resolveFormat(): "pretty" | "json" {
  return env.LOG_FORMAT ?? (env.NODE_ENV === "production" ? "json" : "pretty");
}

/** "error" under NODE_ENV=test so the real integration paths this logger now
 * runs through (handleTurn, executed by tests hitting a real Postgres) stay
 * quiet by default; "info" otherwise. Explicit LOG_LEVEL always wins. */
function resolveLevel(): LogLevel {
  return env.LOG_LEVEL ?? (env.NODE_ENV === "test" ? "error" : "info");
}

/** stdout for everything below error, stderr for error — standard split, and
 * what lets a deployment platform treat error-level lines as failures without
 * parsing message content. */
function write(record: LogRecord): void {
  const line = resolveFormat() === "json" ? JSON.stringify(record) : formatPretty(record);
  if (record.level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export interface Logger {
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  trace(msg: string, fields?: LogFields): void;
  /** Returns a logger that merges `context` into every subsequent call's
   * fields — e.g. one child per conversation turn carrying {turnId, channel,
   * externalId}, so every line from that turn is already correlated without
   * repeating the context at every call site. */
  child(context: LogFields): Logger;
}

class LoggerImpl implements Logger {
  constructor(private readonly context: LogFields = {}) {}

  private log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] > LEVEL_RANK[resolveLevel()]) {
      return; // Skip redaction/serialization work for a level that won't be emitted.
    }
    const merged = { ...this.context, ...fields };
    write({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(redact(merged) as LogFields),
    });
  }

  error(msg: string, fields?: LogFields): void {
    this.log("error", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.log("warn", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.log("info", msg, fields);
  }
  debug(msg: string, fields?: LogFields): void {
    this.log("debug", msg, fields);
  }
  trace(msg: string, fields?: LogFields): void {
    this.log("trace", msg, fields);
  }

  child(context: LogFields): Logger {
    return new LoggerImpl({ ...this.context, ...context });
  }
}

/** Process-wide default. Import this directly, or call `.child(...)` for a
 * request/turn-scoped one — same pattern as pino/bunyan. */
export const logger: Logger = new LoggerImpl();

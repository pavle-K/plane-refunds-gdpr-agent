/**
 * Real Express app on an ephemeral port, real HTTP requests — same "no
 * supertest needed" approach used by tests/integration/api/*.route.test.ts.
 * Unlike those, this stays under tests/unit/ deliberately: it never touches
 * Postgres, because a request rejected for a missing/wrong webhook secret
 * returns 401 before src/operator/session.ts's handleTurn (and its DB calls)
 * is ever reached — see telegram.routes.ts's route handler.
 *
 * env.TELEGRAM_WEBHOOK_SECRET is whatever this process's real environment has
 * configured (env.ts is a module-level singleton parsed once at import,
 * unlike tests/unit/config/env.test.ts's dynamic-reimport tests) — that's
 * fine here: this suite specifically wants "a secret IS configured" to
 * exercise the check, which is the case in any real deployment (see Segment
 * 6's env.ts production enforcement).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { createTelegramWebhookRouter, describeUserFacingError } from "../../../../../src/api/routes/channels/telegram.routes.js";
import { FakeChatModel } from "../../../../../src/agent/llm/fake-chat-model.js";
import { LlmRateLimitedError } from "../../../../../src/agent/llm/rate-limit-error.js";
import { env } from "../../../../../src/config/env.js";

const canRun = Boolean(env.TELEGRAM_WEBHOOK_SECRET);

describe("describeUserFacingError", () => {
  it("gives an actionable, specific message with a retry hint for a rate limit", () => {
    const message = describeUserFacingError(new LlmRateLimitedError("Gemini", 37.5, "quota exceeded"));
    expect(message).toContain("rate-limited");
    expect(message).toContain("38s"); // Math.ceil(37.5)
  });

  it("gives an actionable message without a specific delay when none was provided", () => {
    const message = describeUserFacingError(new LlmRateLimitedError("Gemini", undefined, "quota exceeded"));
    expect(message).toContain("rate-limited");
    expect(message).not.toContain("undefined");
  });

  it("falls back to a generic message for any other error", () => {
    const message = describeUserFacingError(new Error("boom"));
    expect(message).toBe("Sorry, something went wrong on my end — please try again.");
  });
});

describe.skipIf(!canRun)("POST /webhooks/telegram — secret enforcement", () => {
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use(createTelegramWebhookRouter(new FakeChatModel()));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 401 when the secret header is missing entirely", async () => {
    const res = await fetch(`${baseUrl}/webhooks/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { text: "hi", chat: { id: 1 } } }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the secret header doesn't match", async () => {
    const res = await fetch(`${baseUrl}/webhooks/telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": `${env.TELEGRAM_WEBHOOK_SECRET}-wrong`,
      },
      body: JSON.stringify({ message: { text: "hi", chat: { id: 1 } } }),
    });
    expect(res.status).toBe(401);
  });

  it("acks with 200 (not 401) once the secret header matches", async () => {
    const res = await fetch(`${baseUrl}/webhooks/telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET!,
      },
      // No `message` key — parseTelegramUpdate returns null for this, so the
      // route still acks 200 (Telegram requires a fast 2xx regardless) but
      // never calls handleTurn, keeping this test DB-free.
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(200);
  });
});

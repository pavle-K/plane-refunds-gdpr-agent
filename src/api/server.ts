/**
 * Hosts inbound messaging-channel webhooks (Telegram today; Discord/WhatsApp/
 * Viber/Facebook slot in the same way once built — see src/channels/) so users
 * can chat with the operator from outside a terminal. Each webhook route
 * normalizes its platform's payload and calls the same
 * src/operator/session.ts handleTurn() the CLI uses — one conversation
 * pipeline, many front doors.
 *
 * Usage: npm run server
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { setupCheckpointer, getCheckpointer } from "../agent/checkpointer.js";
import { createChatModel } from "../agent/llm/chat-model.js";
import { FakeChatModel } from "../agent/llm/fake-chat-model.js";
import { flushTracing } from "../agent/llm/index.js";
import { createTelegramWebhookRouter } from "./routes/channels/telegram.routes.js";
import { createOAuthCallbackRouter } from "./routes/oauth.routes.js";
import { createWebApiRouter } from "./routes/web/index.js";
import { createWebSessionMiddleware } from "./middleware/web-session.js";
import { createPublicEndpointRateLimiter } from "./middleware/rate-limit.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/** The built SPA (`cd web && npm run build`) — served same-origin, same
 * process/port as the API, so production needs no CORS config and no second
 * public URL to register anywhere (Google's OAuth allowlist included; see
 * PUBLIC_URL's doc comment). Resolved relative to this file rather than
 * process.cwd() so it's correct regardless of where `node`/`tsx` is invoked
 * from. */
const WEB_DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

async function main() {
  const model = createChatModel();
  if (model instanceof FakeChatModel) {
    throw new Error(
      `LLM_PROVIDER=${env.LLM_PROVIDER} has no key/config set (see .env) — channels can't chat without a real LLM.`,
    );
  }

  logger.info("setting up checkpointer against real Postgres");
  await setupCheckpointer();

  const app = express();
  // This process is always reached through exactly one reverse proxy in every
  // real deployment shape this project supports — ngrok in dev (see
  // scripts/dev-telegram.ts), a load balancer/reverse proxy in production —
  // never exposed directly to the internet. "1" tells Express to trust the
  // X-Forwarded-For entry added by that one hop (and no further back) when
  // determining the client IP, which is what the rate limiter keys on.
  // Without this, Express rejects any request carrying an X-Forwarded-For
  // header at all — exactly what a reverse proxy always adds.
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(cookieParser());

  app.get("/healthz", (_req, res) => res.sendStatus(200));
  app.use(createPublicEndpointRateLimiter(), createTelegramWebhookRouter(model));
  app.use(createPublicEndpointRateLimiter(), createOAuthCallbackRouter(model));
  app.use(createWebSessionMiddleware(), createPublicEndpointRateLimiter(), createWebApiRouter(model));

  // Same-origin static serving of the built SPA — see WEB_DIST_DIR's doc
  // comment. Only attempted if a build actually exists: `npm run dev:web`
  // runs the SPA through Vite's own dev server instead (see that script's
  // doc comment), so a dev environment with no `web/dist` yet is expected,
  // not an error.
  const webIndexHtml = join(WEB_DIST_DIR, "index.html");
  if (existsSync(webIndexHtml)) {
    app.use(express.static(WEB_DIST_DIR));
    // SPA client-side routing fallback — any GET that didn't match a static
    // file or an API route above resolves to index.html, so e.g. a hard
    // reload on /claims/abc123 works. Placed last, so it never shadows any
    // route mounted above it.
    app.get(/.*/, (_req, res) => res.sendFile(webIndexHtml));
  } else {
    logger.warn("web/dist/index.html not found — the API is up but no frontend build is being served", {
      hint: "run `cd web && npm run build`, or use `npm run dev:web` for local development",
    });
  }

  const server = app.listen(env.PORT, () => {
    logger.info("API listening", { port: env.PORT, llmProvider: env.LLM_PROVIDER, logLevel: env.LOG_LEVEL });
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => {
        // Langfuse batches trace events and flushes on an internal timer —
        // without this, whatever's queued from the last few turns before
        // shutdown is silently lost. No-ops when Langfuse isn't configured.
        void Promise.all([getCheckpointer().end(), flushTracing()]).finally(() => process.exit(0));
      });
    });
  }
}

main().catch((cause) => {
  logger.error("server failed to start", { cause: String(cause) });
  process.exit(1);
});

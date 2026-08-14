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
import express from "express";
import { setupCheckpointer, getCheckpointer } from "../agent/checkpointer.js";
import { createLlmClient, FakeLlmClient, flushTracing } from "../agent/llm/index.js";
import { createTelegramWebhookRouter } from "./routes/channels/telegram.routes.js";
import { createOAuthCallbackRouter } from "./routes/oauth.routes.js";
import { createPublicEndpointRateLimiter } from "./middleware/rate-limit.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

async function main() {
  const llm = createLlmClient();
  if (llm instanceof FakeLlmClient) {
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

  app.get("/healthz", (_req, res) => res.sendStatus(200));
  app.use(createPublicEndpointRateLimiter(), createTelegramWebhookRouter(llm));
  app.use(createPublicEndpointRateLimiter(), createOAuthCallbackRouter(llm));

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

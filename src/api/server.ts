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
import { createLlmClient, FakeLlmClient } from "../agent/llm/index.js";
import { createTelegramWebhookRouter } from "./routes/channels/telegram.routes.js";
import { createOAuthCallbackRouter } from "./routes/oauth.routes.js";
import { createPublicEndpointRateLimiter } from "./middleware/rate-limit.js";
import { env } from "../config/env.js";

async function main() {
  const llm = createLlmClient();
  if (llm instanceof FakeLlmClient) {
    throw new Error(
      `LLM_PROVIDER=${env.LLM_PROVIDER} has no key/config set (see .env) — channels can't chat without a real LLM.`,
    );
  }

  console.log("Setting up checkpointer against real Postgres...");
  await setupCheckpointer();

  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => res.sendStatus(200));
  app.use(createPublicEndpointRateLimiter(), createTelegramWebhookRouter(llm));
  app.use(createPublicEndpointRateLimiter(), createOAuthCallbackRouter());

  const server = app.listen(env.PORT, () => {
    console.log(`API listening on :${env.PORT} (LLM_PROVIDER=${env.LLM_PROVIDER})`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => {
        void getCheckpointer()
          .end()
          .finally(() => process.exit(0));
      });
    });
  }
}

main().catch((cause) => {
  console.error("FAILED to start server:", cause);
  process.exit(1);
});

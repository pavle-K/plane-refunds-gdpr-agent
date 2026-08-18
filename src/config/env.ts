import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Required to actually run anything that touches Postgres (the checkpointer, the
  // CLI scripts, migrations) — but validated lazily at that point of use
  // (db/client.ts's assertDatabaseConfigured()), not eagerly here. Optional at the
  // schema level so pure unit tests — which use fake adapters and never touch a
  // real database — can import modules that reference `env`
  // without needing Postgres to exist, in CI or anywhere else.
  DATABASE_URL: z
    .string()
    .min(1)
    .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres connection string")
    .optional(),

  // Which LLM provider backs createLlmClient() — see src/agent/llm/index.ts.
  // Switching providers is this value (+ optionally LLM_MODEL); no code changes.
  LLM_PROVIDER: z.enum(["anthropic", "openai", "google", "xai", "openai-compatible"]).default("anthropic"),
  // Overrides the provider's default model id (src/agent/llm/model-registry.ts).
  LLM_MODEL: z.string().min(1).optional(),

  // Required starting Stage 2 (LLM calls). Optional for now so Stage 0/1 work can boot
  // without every provider key present. Only the key for the active LLM_PROVIDER
  // actually needs to be set.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GOOGLE_API_KEY: z.string().min(1).optional(),
  XAI_API_KEY: z.string().min(1).optional(),

  // Generic slot for LLM_PROVIDER=openai-compatible — any endpoint that speaks
  // OpenAI's Chat Completions wire format: hosted (OpenRouter, Groq, Together,
  // DeepSeek's own API, ...) or self-hosted (Ollama, vLLM, LM Studio). Covers
  // every open-weight model this way, so there's no per-model adapter to add.
  OPENAI_COMPATIBLE_BASE_URL: z.string().min(1).optional(),
  // Most local runtimes (e.g. Ollama) ignore this — leave unset for those.
  OPENAI_COMPATIBLE_API_KEY: z.string().min(1).optional(),
  OPENAI_COMPATIBLE_MODEL: z.string().min(1).optional(),

  // Required starting Stage 1 (data providers). Optional for now.
  // No WEATHER_API_KEY: the weather provider is the IEM ASOS archive, which is
  // free and keyless (see src/providers/weather/index.ts).
  FLIGHT_DATA_API_KEY: z.string().min(1).optional(),
  POSTMARK_API_KEY: z.string().min(1).optional(),

  // The From: address outbound claim letters are sent from. Must be an address
  // on a domain this project actually controls and has verified with the email
  // provider — sendClaim refuses to send at all without it rather than falling
  // back to a placeholder (see src/agent/nodes/send-claim.node.ts).
  CLAIM_SENDER_EMAIL: z.string().email().optional(),

  // Gmail/Outlook OAuth apps — each registered separately (see scripts/connect-email.ts).
  GMAIL_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  OUTLOOK_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  OUTLOOK_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),

  // Base64-encoded 32-byte AES-256 key, used to encrypt OAuth tokens at rest.
  // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .optional()
    .refine((value) => value === undefined || Buffer.from(value, "base64").length === 32, {
      message: "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    }),

  // Required starting Stage 2/3 (payouts).
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_CONNECT_CLIENT_ID: z.string().min(1).optional(),

  // Messaging channels (src/channels/) — the operator chat over Telegram/Discord/etc.
  // Each is optional; a channel whose token isn't set falls back to its fake adapter,
  // same convention as every other provider.
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  // Shared secret Telegram echoes back in the X-Telegram-Bot-Api-Secret-Token header
  // on every webhook call — lets src/api/routes/channels/telegram.routes.ts reject
  // requests that didn't actually come from Telegram. Generate any random string.
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),

  // src/lib/logger.ts. Ordered least to most verbose. No static default here
  // (see DATABASE_URL's comment for the general reason optional-with-no-default
  // is used across this file) — src/lib/logger.ts defaults it to "error" under
  // NODE_ENV=test (so the test suite's real integration paths, which now log
  // through handleTurn, stay quiet by default) and "info" otherwise. "info" is
  // the production default because it already answers "did the model call the
  // tool or not", which is the question that actually needed answering the one
  // time this repo shipped without any logging at all and a live incident
  // couldn't be proven either way from the chat transcript alone.
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug", "trace"]).optional(),
  // "pretty" (short, human-readable, colorized) vs "json" (one JSON object per
  // line, for a real log platform). No static default here — src/lib/logger.ts
  // defaults it from NODE_ENV (pretty in development, json otherwise), same
  // convention as the NODE_ENV-conditional factories elsewhere in this repo
  // (e.g. providers/flight-status/index.ts).
  LOG_FORMAT: z.enum(["pretty", "json"]).optional(),

  // Langfuse — LLM tracing (production observability) and dataset-driven prompt
  // evals (tests/evals/). Both optional, same fallback convention as every other
  // provider here: unset means src/agent/llm/langfuse-client.ts hands back null
  // and tracing/eval-reporting silently no-ops, never blocking a turn or a run.
  LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
  LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
  // Defaults to Langfuse Cloud's EU region if unset. This project keeps its
  // Postgres in Frankfurt specifically for EU data residency — traces carry
  // raw prompts, which include passenger PII, so the same reasoning applies
  // here. Only override for self-hosted or the US region.
  LANGFUSE_HOST: z.string().url().optional(),

  // src/operator/session.ts — max estimated tokens of prior conversation
  // replayed on every turn (the trigger for the operator agent's context-editing
  // middleware). A real conversation (trace.log, 2026-08-14) hit the old fixed
  // 40-turn cap while including a full drafted claim letter, making every
  // subsequent request enormous. Token-based, not count-based, since turn
  // length varies from "yes" to a full letter.
  MAX_HISTORY_TOKENS: z.coerce.number().int().positive().default(6000),

  // src/api/server.ts — hosts inbound channel webhooks.
  PORT: z.coerce.number().int().positive().default(3000),

  // The public HTTPS origin this server is reachable at (e.g.
  // https://claims.example.com) — used to build the hosted OAuth redirect URI
  // (src/providers/email-ingest/oauth-redirect-uri.ts's getHostedRedirectUri).
  // Optional at the schema level (see DATABASE_URL's comment for why); actually
  // required to start a hosted OAuth flow, checked lazily at that point of use.
  PUBLIC_URL: z.string().url().optional(),
});

/** Vars that are optional at the schema level (so unit tests and early-stage
 * local dev can boot without them, per this file's existing convention) but
 * fail closed rather than silently permissive once NODE_ENV=production:
 * without TELEGRAM_WEBHOOK_SECRET the webhook route accepts unauthenticated
 * requests, without PUBLIC_URL the hosted OAuth flow can't build a redirect
 * URI, without TOKEN_ENCRYPTION_KEY connected mailboxes' tokens can't be
 * stored — none of those should be discovered at request time in production. */
const REQUIRED_IN_PRODUCTION = ["TELEGRAM_WEBHOOK_SECRET", "PUBLIC_URL", "TOKEN_ENCRYPTION_KEY"] as const;

const envSchemaWithProductionChecks = envSchema.superRefine((data, ctx) => {
  if (data.NODE_ENV !== "production") {
    return;
  }
  for (const key of REQUIRED_IN_PRODUCTION) {
    if (!data[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must be set when NODE_ENV=production.`,
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const result = envSchemaWithProductionChecks.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid environment configuration:");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const env = parseEnv();

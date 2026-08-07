import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Required to actually run anything that touches Postgres (the checkpointer, the
  // CLI scripts, migrations) — but validated lazily at that point of use
  // (db/client.ts's assertDatabaseConfigured()), not eagerly here. Optional at the
  // schema level so pure unit tests — which use fake adapters and never touch a
  // real database, see CLAUDE.md §5 — can import modules that reference `env`
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
  FLIGHT_DATA_API_KEY: z.string().min(1).optional(),
  WEATHER_API_KEY: z.string().min(1).optional(),
  POSTMARK_API_KEY: z.string().min(1).optional(),

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

  // src/api/server.ts — hosts inbound channel webhooks.
  PORT: z.coerce.number().int().positive().default(3000),

  // The public HTTPS origin this server is reachable at (e.g.
  // https://claims.example.com) — used to build the hosted OAuth redirect URI
  // (src/providers/email-ingest/oauth-redirect-uri.ts's getHostedRedirectUri).
  // Optional at the schema level (see DATABASE_URL's comment for why); actually
  // required to start a hosted OAuth flow, checked lazily at that point of use.
  PUBLIC_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

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

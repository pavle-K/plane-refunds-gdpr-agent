import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Required from Stage 0 onward — the graph cannot boot without a checkpoint store.
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres connection string"),

  // Required starting Stage 2 (LLM calls). Optional for now so Stage 0/1 work can boot
  // without every provider key present.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  // Required starting Stage 1 (data providers). Optional for now.
  FLIGHT_DATA_API_KEY: z.string().min(1).optional(),
  WEATHER_API_KEY: z.string().min(1).optional(),
  EMAIL_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  EMAIL_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  POSTMARK_API_KEY: z.string().min(1).optional(),

  // Required starting Stage 2/3 (payouts).
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_CONNECT_CLIENT_ID: z.string().min(1).optional(),
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

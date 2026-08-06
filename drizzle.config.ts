import { defineConfig } from "drizzle-kit";
import { env } from "./src/config/env.js";

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set in .env to run drizzle-kit (db:generate/db:migrate).");
}
const databaseUrl = env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});

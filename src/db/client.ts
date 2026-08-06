import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

export class MissingDatabaseUrlError extends Error {
  constructor() {
    super("DATABASE_URL must be set in .env to connect to Postgres — see .env.example");
    this.name = "MissingDatabaseUrlError";
  }
}

/** Every real entry point that's about to actually use Postgres (the checkpointer,
 * CLI scripts) calls this first, so a missing DATABASE_URL fails fast with a clear
 * message — same convention as requireEncryptionKey() in email-connection.repo.ts.
 * `pool` below is constructed eagerly regardless (pg.Pool doesn't connect until the
 * first query, so this is safe even when DATABASE_URL is unset), which is what lets
 * unit tests import repositories without a database existing anywhere. */
export function assertDatabaseConfigured(): string {
  if (!env.DATABASE_URL) {
    throw new MissingDatabaseUrlError();
  }
  return env.DATABASE_URL;
}

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

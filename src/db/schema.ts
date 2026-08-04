import { pgTable, text, timestamp, jsonb, uuid, unique } from "drizzle-orm/pg-core";

/**
 * Append-only by application-level convention: db/repositories/audit.repo.ts only
 * exposes insert/select, never update/delete. DB-level enforcement (a trigger
 * rejecting UPDATE/DELETE) is Stage 3 hardening — see CLAUDE.md §5.6.
 */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  claimId: text("claim_id").notNull(),
  entryType: text("entry_type").notNull(), // "llm_output" | "human_decision"
  payload: jsonb("payload").notNull(),
  createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * accessToken/refreshToken are stored encrypted (src/lib/crypto.ts) — never
 * plaintext. One row per connected inbox; provider+emailAddress is unique so
 * reconnecting the same inbox updates rather than duplicates.
 */
export const emailConnections = pgTable(
  "email_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(), // "gmail" | "outlook"
    emailAddress: text("email_address").notNull(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    accessTokenExpiresAtUtc: timestamp("access_token_expires_at_utc", { withTimezone: true }).notNull(),
    createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
    updatedAtUtc: timestamp("updated_at_utc", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.provider, table.emailAddress)],
);

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

/**
 * One row per (channel, externalId) — e.g. a Telegram chat id, a Discord user
 * id, or an email address. This is the identity the operator chat session
 * (src/operator/session.ts) is keyed on, regardless of which messaging app the
 * user is talking through. channel+externalId is unique so re-messaging from
 * the same chat resolves to the same identity rather than duplicating it.
 */
export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: text("channel").notNull(), // "cli" | "telegram" | "discord" | "whatsapp" | "viber" | "facebook" | "email"
    externalId: text("external_id").notNull(),
    createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.channel, table.externalId)],
);

/**
 * Chat turns for a channel identity, in send order — this is what
 * src/operator/session.ts loads as LLM conversation history and appends to
 * after each turn, replacing the in-memory-only history the CLI used to keep.
 */
export const conversationMessages = pgTable("conversation_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelIdentityId: uuid("channel_identity_id")
    .notNull()
    .references(() => channelIdentities.id),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
});

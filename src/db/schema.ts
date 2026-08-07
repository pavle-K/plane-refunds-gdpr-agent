import { pgTable, text, timestamp, jsonb, uuid, unique } from "drizzle-orm/pg-core";

/**
 * One row per person, independent of which channel(s) they talk through or which
 * mailbox they've connected — the owner that email_connections, claims, and
 * consents all point back to. Deliberately minimal: no name/email/etc. here
 * (data minimization); that data lives on the records that actually need it,
 * not duplicated onto the identity row itself.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only by application-level convention: db/repositories/audit.repo.ts only
 * exposes insert/select, never update/delete. DB-level enforcement (a trigger
 * rejecting UPDATE/DELETE) is Stage 3 hardening — see CLAUDE.md §5.6.
 */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Nullable: not every entry is about a claim (e.g. "mailbox_reassigned" is
  // about an email connection, not a LangGraph thread).
  claimId: text("claim_id"),
  // Nullable: some entries (e.g. future system/background-job actions) may not
  // be attributable to a single user. Every entry written by a user-initiated
  // action should set this.
  userId: uuid("user_id").references(() => users.id),
  entryType: text("entry_type").notNull(), // "llm_output" | "human_decision" | "system_action" | "mailbox_reassigned"
  payload: jsonb("payload").notNull(),
  createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * accessToken/refreshToken are stored encrypted (src/lib/crypto.ts) — never
 * plaintext. One row per connected inbox, owned by exactly one user at a time.
 * emailAddress is globally unique (not just per-owner): if a second user later
 * completes real OAuth for an already-connected mailbox, ownership reassigns to
 * them (they just proved control of it) rather than allowing two owners for the
 * same inbox — see EmailConnectionRepo.upsert.
 */
export const emailConnections = pgTable(
  "email_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(), // "gmail" | "outlook"
    emailAddress: text("email_address").notNull(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    accessTokenExpiresAtUtc: timestamp("access_token_expires_at_utc", { withTimezone: true }).notNull(),
    createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
    updatedAtUtc: timestamp("updated_at_utc", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.emailAddress)],
);

/**
 * One row per (channel, externalId) — e.g. a Telegram chat id, a Discord user
 * id, or an email address. This is the identity the operator chat session
 * (src/operator/session.ts) is keyed on, regardless of which messaging app the
 * user is talking through. channel+externalId is unique so re-messaging from
 * the same chat resolves to the same identity rather than duplicating it.
 * Every channel identity belongs to exactly one user, created alongside it on
 * first contact (see UserRepo.getOrCreateUser). v1 is one channel identity per
 * user; linking multiple channels to one existing user is future work, but this
 * shape already supports it (users 1—N channel_identities).
 */
export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    channel: text("channel").notNull(), // "cli" | "telegram" | "discord" | "whatsapp" | "viber" | "facebook" | "email"
    externalId: text("external_id").notNull(),
    createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.channel, table.externalId)],
);

/**
 * One row per accepted consent — append-only, same convention as audit_log.
 * Recorded at first contact before any booking/email data is processed for
 * that user (see src/compliance/consent.ts). policyVersion lets us prove which
 * version of the notice a given user actually saw.
 */
export const consents = pgTable("consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  policyVersion: text("policy_version").notNull(),
  channel: text("channel").notNull(),
  consentedAtUtc: timestamp("consented_at_utc", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Server-held OAuth flow state. The `state` query param handed to Google/
 * Microsoft and back is this row's `id` — not a signed token — which gives
 * free revocability and expiry (mark consumed / check expiresAtUtc) without a
 * token-signing key to manage, consistent with this repo's existing preference
 * for DB-held state (the LangGraph checkpointer) over client-held tokens.
 * channelIdentityId records which chat the flow was started from, so the
 * callback knows where to send the "connected" confirmation.
 */
export const oauthPendingFlows = pgTable("oauth_pending_flows", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  channelIdentityId: uuid("channel_identity_id")
    .notNull()
    .references(() => channelIdentities.id),
  provider: text("provider").notNull(), // "gmail" | "outlook"
  // PKCE code_verifier, generated when the flow starts and needed again at
  // token exchange. Nullable only structurally; every hosted flow sets it.
  codeVerifier: text("code_verifier"),
  createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
  expiresAtUtc: timestamp("expires_at_utc", { withTimezone: true }).notNull(),
  consumedAtUtc: timestamp("consumed_at_utc", { withTimezone: true }),
});

/**
 * Ownership + status mirror for a LangGraph claim thread — deliberately NOT the
 * full claim record. Booking/passenger/compensation data stays in the
 * LangGraph Postgres checkpointer, keyed by this same id (the threadId). This
 * table exists so operator tools can check "does this user own this threadId"
 * before letting them act on it. Full relational claim persistence (matching
 * src/domain/claim/claim.types.ts) is separate, larger future work.
 */
export const claims = pgTable("claims", {
  id: text("id").primaryKey(), // LangGraph threadId
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  status: text("status").notNull(),
  createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
  updatedAtUtc: timestamp("updated_at_utc", { withTimezone: true }).notNull().defaultNow(),
});

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

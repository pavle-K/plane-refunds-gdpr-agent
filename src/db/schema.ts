import { pgTable, text, timestamp, jsonb, uuid, unique, doublePrecision } from "drizzle-orm/pg-core";

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
 * rejecting UPDATE/DELETE) is Stage 3 hardening.
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
    // Set once, the first time the consent notice is shown to this identity —
    // gates auto-consent (src/compliance/consent.ts's decideConsent) before a
    // userId has actually consented. Nullable: unset means never shown.
    // Deliberately a dedicated column rather than a history scan: the LangChain
    // agent's checkpointer thread (src/operator/session.ts) is the agent's own
    // reasoning memory, not a general-purpose compliance transcript, and
    // consent-gate-blocked turns never invoke the agent at all so there would
    // be nothing to scan.
    noticeShownAtUtc: timestamp("notice_shown_at_utc", { withTimezone: true }),
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
 *
 * bookingReference + the (userId, bookingReference) unique constraint are what
 * make ClaimRepo.findByBookingReference an authoritative identity check —
 * OperatorTools.startClaim uses it to make a re-check of an already-known
 * booking always return the EXISTING claim's real stored facts, never a fresh
 * pipeline run seeded with whatever (possibly wrong) flight/date the LLM
 * reconstructed this time. The unique constraint is the DB-level backstop for
 * that same invariant, not just the application-level check-then-create.
 */
export const claims = pgTable(
  "claims",
  {
    id: text("id").primaryKey(), // LangGraph threadId
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    bookingReference: text("booking_reference").notNull(),
    status: text("status").notNull(),
    createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
    updatedAtUtc: timestamp("updated_at_utc", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.userId, table.bookingReference)],
);

/**
 * Server-held confirmation gate for irreversible actions (forget_my_data,
 * disconnect_email) — deliberately mirrors oauth_pending_flows' shape and
 * reasoning: the LLM can request one of these actions (recognizing intent
 * from natural language is legitimate LLM work), but whether it actually
 * executes is decided by deterministic code matching an explicit "yes"
 * against this row on the user's very next message, never by anything the
 * LLM itself generates. This exists because an LLM can hallucinate having
 * completed an irreversible action without ever calling its tool — see
 * src/operator/session.ts's pending-confirmation handling, which is checked
 * before a message ever reaches the LLM, same as the consent gate.
 * Short-lived by design (expiresAtUtc) and consumed on the very next message
 * regardless of outcome, so a stray "yes" said later for an unrelated reason
 * can never retroactively confirm a stale request.
 */
export const pendingConfirmations = pgTable("pending_confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  channelIdentityId: uuid("channel_identity_id")
    .notNull()
    .references(() => channelIdentities.id),
  actionType: text("action_type").notNull(), // "forget_my_data" | "disconnect_email"
  actionParams: jsonb("action_params").notNull(), // e.g. { provider: "gmail" } for disconnect_email
  createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
  expiresAtUtc: timestamp("expires_at_utc", { withTimezone: true }).notNull(),
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

/**
 * Geographic reference facts for airports (great-circle coordinates + which
 * country they're in) — this is the real data source behind
 * src/providers/airport-reference/, which is what src/domain/ec261/distance.ts
 * (compensation distance banding) and eu-membership.ts (route-coverage) are
 * fed from. Deliberately does NOT store an EU-membership boolean here: this
 * table holds sourced GEOGRAPHIC facts only (countryIsoCode is just "which
 * country"), and whether that country counts as "EU" for EC261 purposes is a
 * legal classification applied in src/domain/ec261/eu-membership.ts — keeping
 * that judgment out of a data-import table means a bad row here can be
 * geographically wrong at worst, never silently misjudge the law.
 *
 * `source` records how a row got here: "ourairports" for the bulk import
 * (scripts/import-airports.ts) vs "aeroapi_lookup" for a row filled in live by
 * the self-healing fallback (src/providers/airport-reference/db.adapter.ts)
 * when a code was missing from that import — kept for auditability of where a
 * money-affecting distance figure's underlying coordinates actually came from.
 */
export const airports = pgTable("airports", {
  iataCode: text("iata_code").primaryKey(),
  icaoCode: text("icao_code").notNull(),
  name: text("name").notNull(),
  countryIsoCode: text("country_iso_code").notNull(),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  source: text("source").notNull(), // "ourairports" | "aeroapi_lookup"
  createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
  updatedAtUtc: timestamp("updated_at_utc", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The person filing claims, collected once and reused — without it every claim
 * letter and submission packet renders with unfilled brackets and an "Unknown
 * Passenger" placeholder, and the agent has to notice that gap ad hoc in
 * conversation with nothing enforcing it.
 *
 * One row per user, not per passenger: the assumption is that the person
 * talking to the bot is claiming for themselves. Where an airline also wants
 * co-passengers' details (British Airways does), the user supplies those on the
 * airline's own form — see the claim-fields vocabulary, which classifies
 * co-passenger facts as per-claim rather than profile data.
 *
 * iban/bic are stored ENCRYPTED (src/lib/crypto.ts), same pattern as
 * email_connections' OAuth tokens: encrypted at the repository boundary, so
 * PassengerProfileRepo's interface deals in plaintext and nothing above it
 * knows. Consequence worth remembering: an encrypted column is not searchable,
 * so never key a lookup on one.
 *
 * Unlike a claim, a profile is not itself a legal record of a transaction — a
 * sent claim's letter text already carries the name and address into the audit
 * trail. So forget_my_data deletes this unconditionally, with none of the
 * "was it already sent?" reasoning that governs claims.
 */
export const passengerProfiles = pgTable(
  "passenger_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    fullName: text("full_name").notNull(),
    // Address lines are split rather than free-text so a submission packet can
    // present them the way a form asks for them, field by field.
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    postalCode: text("postal_code"),
    countryIsoCode: text("country_iso_code"),
    contactEmail: text("contact_email").notNull(),
    phone: text("phone"),
    // Nullable because a profile is useful before bank details are known: a user
    // can check eligibility and see the form URL without ever handing over an
    // IBAN. Only asked for when a specific carrier's form actually requires it.
    encryptedIban: text("encrypted_iban"),
    encryptedBic: text("encrypted_bic"),
    createdAtUtc: timestamp("created_at_utc", { withTimezone: true }).notNull().defaultNow(),
    updatedAtUtc: timestamp("updated_at_utc", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.userId)],
);

import { pgTable, text, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";

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

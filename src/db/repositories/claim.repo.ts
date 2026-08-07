import { desc, eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { claims } from "../schema.js";

export interface ClaimOwnershipRow {
  id: string;
  userId: string;
  status: string;
  createdAtUtc: Date;
  updatedAtUtc: Date;
}

/** Ownership + status mirror for a LangGraph claim thread — see schema.ts's
 * claims table doc comment. Deliberately NOT the full claim record; that stays
 * in the LangGraph Postgres checkpointer, keyed by the same id. */
export class ClaimRepo {
  async create(id: string, userId: string, status: string): Promise<void> {
    await db.insert(claims).values({ id, userId, status });
  }

  async findById(id: string): Promise<ClaimOwnershipRow | null> {
    const rows = await db.select().from(claims).where(eq(claims.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async updateStatus(id: string, status: string): Promise<void> {
    // sql`now()` (DB server clock), not `new Date()` (app server clock) — this
    // column drives findMostRecentForUser's ordering below, and this repo's
    // Postgres is remote, so an app-clock timestamp can't be safely compared
    // against another row's DB-computed defaultNow() if the two clocks skew.
    await db
      .update(claims)
      .set({ status, updatedAtUtc: sql`now()` })
      .where(eq(claims.id, id));
  }

  /** The claim this user most recently started or touched — replaces
   * process-memory "lastThreadId" convenience state so it works across
   * horizontally-scaled instances (see src/operator/session.ts). */
  async findMostRecentForUser(userId: string): Promise<ClaimOwnershipRow | null> {
    const rows = await db
      .select()
      .from(claims)
      .where(eq(claims.userId, userId))
      .orderBy(desc(claims.updatedAtUtc))
      .limit(1);
    return rows[0] ?? null;
  }
}

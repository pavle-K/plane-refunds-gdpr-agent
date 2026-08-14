import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { claims } from "../schema.js";

export interface ClaimOwnershipRow {
  id: string;
  userId: string;
  bookingReference: string;
  status: string;
  createdAtUtc: Date;
  updatedAtUtc: Date;
}

/** Ownership + status mirror for a LangGraph claim thread — see schema.ts's
 * claims table doc comment. Deliberately NOT the full claim record; that stays
 * in the LangGraph Postgres checkpointer, keyed by the same id. */
export class ClaimRepo {
  async create(id: string, userId: string, bookingReference: string, status: string): Promise<void> {
    await db.insert(claims).values({ id, userId, bookingReference, status });
  }

  async findById(id: string): Promise<ClaimOwnershipRow | null> {
    const rows = await db.select().from(claims).where(eq(claims.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** The authoritative identity check behind OperatorTools.startClaim's
   * re-check protection — see schema.ts's claims table doc comment for why
   * this exists: a booking reference this user has already checked must
   * always resolve back to that SAME claim, never spawn a new one seeded
   * with possibly-different (wrong) flight/date inputs. */
  async findByBookingReference(userId: string, bookingReference: string): Promise<ClaimOwnershipRow | null> {
    const rows = await db
      .select()
      .from(claims)
      .where(and(eq(claims.userId, userId), eq(claims.bookingReference, bookingReference)))
      .limit(1);
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

  /** Every claim this user owns, any status — used by erasure requests to
   * decide, per claim, whether it's safe to delete (never sent) or must be
   * kept (see OperatorTools.forgetMyData). */
  async findAllForUser(userId: string): Promise<ClaimOwnershipRow[]> {
    return db.select().from(claims).where(eq(claims.userId, userId));
  }

  /** Deletes only the ownership/status mirror row — callers that also need
   * the underlying LangGraph checkpoint state gone must call
   * PostgresSaver.deleteThread(id) themselves (see OperatorTools.forgetMyData);
   * this repo has no reference to the checkpointer. */
  async delete(id: string): Promise<void> {
    await db.delete(claims).where(eq(claims.id, id));
  }
}

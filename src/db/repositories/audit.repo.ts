import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { auditLog } from "../schema.js";

export interface AuditLogRow {
  id: string;
  claimId: string | null;
  userId: string | null;
  entryType: string;
  payload: unknown;
  createdAtUtc: Date;
}

/** Insert/select only — no update or delete methods, by design (see schema.ts). */
export class AuditRepo {
  async append(entry: { claimId?: string; userId?: string; entryType: string; payload: unknown }): Promise<void> {
    await db.insert(auditLog).values({
      claimId: entry.claimId,
      userId: entry.userId,
      entryType: entry.entryType,
      payload: entry.payload,
    });
  }

  async listByClaim(claimId: string): Promise<AuditLogRow[]> {
    return db.select().from(auditLog).where(eq(auditLog.claimId, claimId));
  }

  /** Entries not tied to a claim (e.g. "mailbox_reassigned") still have a
   * userId — this is how those get found. Also the shape a future DSAR export
   * will need: every audit entry attributable to a user. */
  async listByUser(userId: string): Promise<AuditLogRow[]> {
    return db.select().from(auditLog).where(eq(auditLog.userId, userId));
  }
}

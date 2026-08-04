import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { auditLog } from "../schema.js";

export interface AuditLogRow {
  id: string;
  claimId: string;
  entryType: string;
  payload: unknown;
  createdAtUtc: Date;
}

/** Insert/select only — no update or delete methods, by design (see schema.ts). */
export class AuditRepo {
  async append(entry: { claimId: string; entryType: string; payload: unknown }): Promise<void> {
    await db.insert(auditLog).values({
      claimId: entry.claimId,
      entryType: entry.entryType,
      payload: entry.payload,
    });
  }

  async listByClaim(claimId: string): Promise<AuditLogRow[]> {
    return db.select().from(auditLog).where(eq(auditLog.claimId, claimId));
  }
}

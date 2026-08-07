import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { consents } from "../schema.js";

/** Append-only by convention, same as audit_log — no update/delete method here. */
export class ConsentRepo {
  async hasConsented(userId: string): Promise<boolean> {
    const rows = await db.select({ id: consents.id }).from(consents).where(eq(consents.userId, userId)).limit(1);
    return rows.length > 0;
  }

  async record(input: { userId: string; policyVersion: string; channel: string }): Promise<void> {
    await db.insert(consents).values(input);
  }
}

import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { consents } from "../schema.js";

/** Insert/read are append-only in normal operation — nothing ever edits or
 * revokes a past consent record silently. delete() is the one deliberate
 * exception, reserved for forget_my_data: erasing the record entirely (not
 * editing it) is a different operation from falsifying consent history, and
 * it composes correctly with decideConsent (src/compliance/consent.ts) —
 * once gone, the next message from this user re-triggers the consent notice
 * from scratch, exactly as if they'd never agreed. */
export class ConsentRepo {
  async hasConsented(userId: string): Promise<boolean> {
    const rows = await db.select({ id: consents.id }).from(consents).where(eq(consents.userId, userId)).limit(1);
    return rows.length > 0;
  }

  async record(input: { userId: string; policyVersion: string; channel: string }): Promise<void> {
    await db.insert(consents).values(input);
  }

  async deleteForUser(userId: string): Promise<void> {
    await db.delete(consents).where(eq(consents.userId, userId));
  }
}

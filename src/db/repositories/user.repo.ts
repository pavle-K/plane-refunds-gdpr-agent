import { eq } from "drizzle-orm";
import { db } from "../client.js";
import { users, channelIdentities } from "../schema.js";

/** People, independent of which channel(s) they talk through or which mailbox
 * they've connected. */
export class UserRepo {
  async createUser(): Promise<string> {
    const rows = await db.insert(users).values({}).returning({ id: users.id });
    const row = rows[0];
    if (!row) {
      throw new Error("Failed to create user");
    }
    return row.id;
  }

  /** Cheap lookup for callers that already resolved a channelIdentityId (e.g. a
   * session keyed on it) and now need the owning user id — avoids re-deriving it
   * from (channel, externalId). */
  async getUserIdForChannelIdentity(channelIdentityId: string): Promise<string | null> {
    const rows = await db
      .select({ userId: channelIdentities.userId })
      .from(channelIdentities)
      .where(eq(channelIdentities.id, channelIdentityId))
      .limit(1);
    return rows[0]?.userId ?? null;
  }
}

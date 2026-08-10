import { eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { oauthPendingFlows } from "../schema.js";
import type { EmailProviderName } from "./email-connection.repo.js";

export interface PendingOAuthFlow {
  id: string;
  userId: string;
  channelIdentityId: string;
  provider: EmailProviderName;
  codeVerifier: string | null;
  expiresAtUtc: Date;
  consumedAtUtc: Date | null;
}

/** Server-held OAuth flow state — see schema.ts's oauth_pending_flows doc
 * comment for why this is a DB row rather than a signed token. */
export class OAuthPendingFlowRepo {
  /** Creates a new pending flow and returns its id — this id IS the `state`
   * query param handed to the provider's /authorize endpoint and back. */
  async create(input: {
    userId: string;
    channelIdentityId: string;
    provider: EmailProviderName;
    codeVerifier: string | null;
    expiresAtUtc: Date;
  }): Promise<string> {
    const rows = await db.insert(oauthPendingFlows).values(input).returning({ id: oauthPendingFlows.id });
    const row = rows[0];
    if (!row) {
      throw new Error("Failed to create OAuth pending flow");
    }
    return row.id;
  }

  async findById(id: string): Promise<PendingOAuthFlow | null> {
    const rows = await db.select().from(oauthPendingFlows).where(eq(oauthPendingFlows.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      userId: row.userId,
      channelIdentityId: row.channelIdentityId,
      provider: row.provider as EmailProviderName,
      codeVerifier: row.codeVerifier,
      expiresAtUtc: row.expiresAtUtc,
      consumedAtUtc: row.consumedAtUtc,
    };
  }

  /** Marks a flow consumed. Callers must check `consumedAtUtc === null` (and
   * `expiresAtUtc`) themselves before acting on a flow — this method doesn't
   * enforce single-use itself, it just records the fact once the caller has
   * decided the flow is valid and is about to act on it. */
  async markConsumed(id: string): Promise<void> {
    await db.update(oauthPendingFlows).set({ consumedAtUtc: sql`now()` }).where(eq(oauthPendingFlows.id, id));
  }
}

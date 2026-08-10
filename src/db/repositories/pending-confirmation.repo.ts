import { and, eq, gt } from "drizzle-orm";
import { db } from "../client.js";
import { pendingConfirmations } from "../schema.js";

export type ConfirmableActionType = "forget_my_data" | "disconnect_email";

export interface PendingConfirmation {
  id: string;
  userId: string;
  channelIdentityId: string;
  actionType: ConfirmableActionType;
  actionParams: Record<string, unknown>;
  expiresAtUtc: Date;
}

/** Server-held confirmation gate for irreversible actions — see schema.ts's
 * pending_confirmations doc comment for why this exists and how it's used. */
export class PendingConfirmationRepo {
  async create(input: {
    userId: string;
    channelIdentityId: string;
    actionType: ConfirmableActionType;
    actionParams: Record<string, unknown>;
    expiresAtUtc: Date;
  }): Promise<string> {
    const rows = await db.insert(pendingConfirmations).values(input).returning({ id: pendingConfirmations.id });
    const row = rows[0];
    if (!row) {
      throw new Error("Failed to create pending confirmation");
    }
    return row.id;
  }

  /** The one active (not expired) pending confirmation for this user, if any
   * — checked before every message reaches the LLM (see session.ts). Only
   * ever at most one per user in practice: creating a new one doesn't
   * explicitly clear an old one, but resolve() always consumes whatever is
   * found before a new request could plausibly create another. */
  async findActiveForUser(userId: string): Promise<PendingConfirmation | null> {
    const rows = await db
      .select()
      .from(pendingConfirmations)
      .where(and(eq(pendingConfirmations.userId, userId), gt(pendingConfirmations.expiresAtUtc, new Date())))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      userId: row.userId,
      channelIdentityId: row.channelIdentityId,
      actionType: row.actionType as ConfirmableActionType,
      actionParams: row.actionParams as Record<string, unknown>,
      expiresAtUtc: row.expiresAtUtc,
    };
  }

  /** Consumes a pending confirmation — called exactly once, regardless of
   * whether the reply confirmed or cancelled it, so it can never be acted on
   * twice and a stray later message can never match it again. */
  async resolve(id: string): Promise<void> {
    await db.delete(pendingConfirmations).where(eq(pendingConfirmations.id, id));
  }
}

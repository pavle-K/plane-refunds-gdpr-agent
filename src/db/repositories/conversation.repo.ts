import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../client.js";
import { channelIdentities, conversationMessages } from "../schema.js";
import type { LlmConversationTurn } from "../../agent/llm/llm.port.js";
import { UserRepo } from "./user.repo.js";

/** How many most-recent turns to fetch from the DB at most — a coarse cap on
 * query size, not the real token bound. The real bound is
 * src/agent/llm/history.ts's truncateHistoryByTokens, applied by callers
 * (session.ts) on top of what this returns; this limit only needs to be
 * generous enough that the token budget, not this row count, is what
 * actually decides how much history survives. */
const DEFAULT_HISTORY_LIMIT = 150;

export class ConversationRepo {
  private readonly userRepo = new UserRepo();

  /** Resolves the internal identity id for a (channel, externalId) pair,
   * creating it — and its owning user, for a brand-new identity — on first
   * contact. channel+externalId is unique, so a concurrent first message from
   * the same chat can't create duplicate identities; at worst it can create one
   * harmless orphan user that never gets linked to an identity, which is an
   * acceptable tradeoff over row-level locking for a first-contact-only path. */
  async getOrCreateIdentity(channel: string, externalId: string): Promise<string> {
    const existing = await db
      .select({ id: channelIdentities.id })
      .from(channelIdentities)
      .where(and(eq(channelIdentities.channel, channel), eq(channelIdentities.externalId, externalId)))
      .limit(1);

    const existingRow = existing[0];
    if (existingRow) {
      return existingRow.id;
    }

    const userId = await this.userRepo.createUser();

    const rows = await db
      .insert(channelIdentities)
      .values({ channel, externalId, userId })
      .onConflictDoUpdate({
        target: [channelIdentities.channel, channelIdentities.externalId],
        set: { channel },
      })
      .returning({ id: channelIdentities.id });

    const row = rows[0];
    if (!row) {
      throw new Error(`Failed to resolve channel identity for ${channel}:${externalId}`);
    }
    return row.id;
  }

  /** Oldest-first, ready to hand straight to LlmClient.completeWithTools({ history }). */
  async loadHistory(channelIdentityId: string, limit = DEFAULT_HISTORY_LIMIT): Promise<LlmConversationTurn[]> {
    const rows = await db
      .select({ role: conversationMessages.role, content: conversationMessages.content })
      .from(conversationMessages)
      .where(eq(conversationMessages.channelIdentityId, channelIdentityId))
      .orderBy(desc(conversationMessages.createdAtUtc))
      .limit(limit);

    return rows.reverse().map((row) => ({ role: row.role as LlmConversationTurn["role"], content: row.content }));
  }

  async appendTurn(channelIdentityId: string, role: LlmConversationTurn["role"], content: string): Promise<void> {
    await db.insert(conversationMessages).values({ channelIdentityId, role, content });
  }

  /** Used by forget_my_data — deletes chat history only, not the identity row
   * itself (so a later message from the same chat resolves to the same
   * identity rather than silently starting a fresh one). */
  async deleteHistory(channelIdentityId: string): Promise<void> {
    await db.delete(conversationMessages).where(eq(conversationMessages.channelIdentityId, channelIdentityId));
  }

  /** Whether the consent notice has ever been shown to this identity before —
   * see channel_identities.noticeShownAtUtc's doc comment and
   * src/compliance/consent.ts's decideConsent for why this is tracked
   * separately from whether the identity has consented. */
  async wasNoticeShown(channelIdentityId: string): Promise<boolean> {
    const rows = await db
      .select({ noticeShownAtUtc: channelIdentities.noticeShownAtUtc })
      .from(channelIdentities)
      .where(eq(channelIdentities.id, channelIdentityId))
      .limit(1);
    return rows[0]?.noticeShownAtUtc != null;
  }

  /** Idempotent — safe to call every time the notice is shown, not just the first. */
  async markNoticeShown(channelIdentityId: string): Promise<void> {
    await db
      .update(channelIdentities)
      .set({ noticeShownAtUtc: new Date() })
      .where(and(eq(channelIdentities.id, channelIdentityId), isNull(channelIdentities.noticeShownAtUtc)));
  }

  /** The reverse of getOrCreateIdentity — given an id, which (channel,
   * externalId) does it belong to. Used to route a proactive, out-of-band
   * message (e.g. the OAuth callback's "you're connected" notification) back
   * to the right chat via the right ChannelAdapter. */
  async findChannelIdentity(channelIdentityId: string): Promise<{ channel: string; externalId: string } | null> {
    const rows = await db
      .select({ channel: channelIdentities.channel, externalId: channelIdentities.externalId })
      .from(channelIdentities)
      .where(eq(channelIdentities.id, channelIdentityId))
      .limit(1);
    return rows[0] ?? null;
  }
}

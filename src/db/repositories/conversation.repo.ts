import { and, desc, eq } from "drizzle-orm";
import { db } from "../client.js";
import { channelIdentities, conversationMessages } from "../schema.js";
import type { LlmConversationTurn } from "../../agent/llm/llm.port.js";
import { UserRepo } from "./user.repo.js";

/** How many most-recent turns to feed back as LLM history — bounds token usage
 * on a long-running conversation instead of replaying it in full forever. */
const DEFAULT_HISTORY_LIMIT = 40;

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

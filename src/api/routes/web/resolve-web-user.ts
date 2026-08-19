import type { Request } from "express";
import { ConversationRepo } from "../../../db/repositories/conversation.repo.js";
import { UserRepo } from "../../../db/repositories/user.repo.js";

export interface WebIdentity {
  userId: string;
  channelIdentityId: string;
}

/**
 * Resolves the (userId, channelIdentityId) pair for the current web session
 * — what every /api/web/* route that calls OperatorTools.dispatch(...) needs
 * first. req.webSessionId is always set for /api/web/* by web-session.ts;
 * throwing (rather than returning null) here is deliberate — Express 5
 * forwards a rejected async handler to its default error middleware (500)
 * automatically, and this should never actually happen outside a
 * misconfigured router mount order.
 */
export async function resolveWebIdentity(req: Request): Promise<WebIdentity> {
  const sessionId = req.webSessionId;
  if (!sessionId) {
    throw new Error("No session established for this request — is web-session.ts mounted ahead of this router?");
  }
  const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("web", sessionId);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) {
    throw new Error(`Channel identity ${channelIdentityId} has no linked user.`);
  }
  return { userId, channelIdentityId };
}

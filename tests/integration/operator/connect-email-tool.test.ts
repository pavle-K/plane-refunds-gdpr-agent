/**
 * Runs against a real local Postgres, same skip convention as the rest of
 * this repo's integration suite. connect_email no longer blocks on a
 * redirect (Segment 4) — this proves the dispatched tool call returns a link
 * immediately, with no network call to the browser/provider involved in the
 * tool call itself (only oauth.routes.ts's callback route touches the
 * provider network, tested separately).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { OperatorTools } from "../../../src/operator/tools.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { OAuthPendingFlowRepo } from "../../../src/db/repositories/oauth-pending-flow.repo.js";

const canRun = Boolean(
  env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY && env.PUBLIC_URL && env.GMAIL_OAUTH_CLIENT_ID && env.GMAIL_OAUTH_CLIENT_SECRET,
);

describe.skipIf(!canRun)("OperatorTools.connect_email (real Postgres)", () => {
  it("returns an authorization link immediately instead of blocking on a redirect", async () => {
    const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("telegram", `test-${randomUUID()}`);
    const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
    if (!userId) throw new Error("expected a linked user");

    const tools = new OperatorTools(userId, channelIdentityId);
    const result = (await tools.dispatch("connect_email", { provider: "gmail" })) as {
      authorizationUrl: string;
      expiresInMinutes: number;
    };

    expect(result.authorizationUrl).toMatch(/^https:\/\/accounts\.google\.com/);
    expect(result.expiresInMinutes).toBeGreaterThan(0);

    const state = new URL(result.authorizationUrl).searchParams.get("state")!;
    const flow = await new OAuthPendingFlowRepo().findById(state);
    expect(flow?.userId).toBe(userId);
    expect(flow?.channelIdentityId).toBe(channelIdentityId);
  });
});

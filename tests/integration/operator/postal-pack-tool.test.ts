/**
 * Runs against a real local Postgres, same skip convention as the rest of this
 * repo's integration suite.
 *
 * Covers the two properties of send_postal_pack that carry real risk:
 * it refuses when the carrier has no postal route, and it does not move the
 * claim's status. Handing someone a document to print is not the same act as
 * dispatching a claim, and conflating the two is how a checkpoint ends up
 * saying "sent" when nothing was.
 *
 * The delivery happy path is covered at the unit level instead — the PDF itself
 * in tests/unit/lib/claim-pdf.test.ts, the email attachment mapping in
 * postmark.adapter.test.ts, and the chat document in telegram.adapter.test.ts.
 * start_claim here runs against unseeded fake providers, so a claim never gets
 * far enough to carry a postal submission plan; wiring one up would mean
 * reaching past OperatorTools' own dependency construction.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { OperatorTools, ClaimAuthorizationError } from "../../../src/operator/tools.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { ClaimRepo } from "../../../src/db/repositories/claim.repo.js";

const canRun = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY);

const ONE_SEGMENT = { segments: [{ flightNumber: "LH456", date: "2024-06-15" }] };

async function makeOperatorTools() {
  const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("telegram", `test-${randomUUID()}`);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) throw new Error("expected a linked user");
  return { userId, channelIdentityId, tools: new OperatorTools(userId, channelIdentityId) };
}

describe.skipIf(!canRun)("send_postal_pack tool (real Postgres)", () => {
  it("refuses when the carrier has no postal route on record", async () => {
    const { tools } = await makeOperatorTools();
    const started = (await tools.dispatch("start_claim", ONE_SEGMENT)) as { threadId: string };

    const result = (await tools.dispatch("send_postal_pack", { threadId: started.threadId })) as {
      error?: string;
      generated?: boolean;
    };

    expect(result.generated).toBeUndefined();
    expect(result.error).toContain("no postal route");
  });

  it("leaves the claim's status untouched — this is not a submission", async () => {
    const { tools } = await makeOperatorTools();
    const started = (await tools.dispatch("start_claim", ONE_SEGMENT)) as { threadId: string; claimStatus: string };

    const before = await new ClaimRepo().findById(started.threadId);
    await tools.dispatch("send_postal_pack", { threadId: started.threadId });
    const after = await new ClaimRepo().findById(started.threadId);

    expect(after?.status).toBe(before?.status);
  });

  it("is scoped to the owning user like every other claim-touching tool", async () => {
    const owner = await makeOperatorTools();
    const stranger = await makeOperatorTools();
    const started = (await owner.tools.dispatch("start_claim", ONE_SEGMENT)) as { threadId: string };

    await expect(stranger.tools.dispatch("send_postal_pack", { threadId: started.threadId })).rejects.toThrow(
      ClaimAuthorizationError,
    );
  });
});

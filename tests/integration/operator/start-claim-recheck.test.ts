/**
 * Runs against a real local Postgres, same skip convention as
 * claim-authorization.test.ts. Added after a real chat session showed the
 * operator LLM silently re-deriving a WRONG date on a re-check ("check the
 * ryanair one") instead of reusing the flight's actual date, producing a
 * contradictory "not found" result the model then fabricated an answer
 * around. This proves the structural fix: a booking reference already on
 * record for a user is authoritative — start_claim ignores new inputs for it
 * and returns the SAME existing claim instead of creating a divergent one.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { OperatorTools } from "../../../src/operator/tools.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { ClaimRepo } from "../../../src/db/repositories/claim.repo.js";

const canRun = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY);

async function makeOperatorTools() {
  const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("telegram", `test-${randomUUID()}`);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) throw new Error("expected a linked user");
  return { tools: new OperatorTools(userId, channelIdentityId), userId, channelIdentityId };
}

describe.skipIf(!canRun)("start_claim re-check enforcement (real Postgres)", () => {
  it("a second call with the same bookingReference but a DIFFERENT date returns the SAME claim, not a new one", async () => {
    const { tools, userId } = await makeOperatorTools();
    const bookingReference = `ELIG-${randomUUID()}`;

    const first = (await tools.dispatch("start_claim", {
      bookingReference,
      segments: [{ flightNumber: "FR725", date: "2026-08-10" }],
    })) as { threadId: string; recheckedExistingClaim?: boolean };

    expect(first.recheckedExistingClaim).toBeUndefined();

    // Simulates the exact real incident: same booking reference, but the
    // model silently substituted a different (wrong) date this time.
    const second = (await tools.dispatch("start_claim", {
      bookingReference,
      segments: [{ flightNumber: "FR725", date: "2026-08-11" }],
    })) as { threadId: string; recheckedExistingClaim?: boolean; note?: string };

    expect(second.threadId).toBe(first.threadId);
    expect(second.recheckedExistingClaim).toBe(true);
    expect(second.note).toContain("already checked");

    // Only one claim row exists for this booking reference — no duplicate
    // was silently created for the wrong-date retry.
    const onRecord = await new ClaimRepo().findByBookingReference(userId, bookingReference);
    expect(onRecord?.id).toBe(first.threadId);
  });

  it("a different bookingReference for the same user creates a genuinely separate claim", async () => {
    const { tools } = await makeOperatorTools();

    const first = (await tools.dispatch("start_claim", {
      bookingReference: `A-${randomUUID()}`,
      segments: [{ flightNumber: "FR725", date: "2026-08-10" }],
    })) as { threadId: string };

    const second = (await tools.dispatch("start_claim", {
      bookingReference: `B-${randomUUID()}`,
      segments: [{ flightNumber: "AZ311", date: "2026-08-10" }],
    })) as { threadId: string; recheckedExistingClaim?: boolean };

    expect(second.threadId).not.toBe(first.threadId);
    expect(second.recheckedExistingClaim).toBeUndefined();
  });
});

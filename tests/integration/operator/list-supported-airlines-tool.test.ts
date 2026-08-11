/**
 * Runs against a real local Postgres, same skip convention as
 * claim-authorization.test.ts. Confirms list_supported_airlines is grounded
 * in the REAL airlines.json data — added after a real chat session showed the
 * operator LLM fabricating an entirely fictional list of "airlines that
 * support email submissions" when no tool existed to answer that question
 * honestly. This is the tool that closes that gap.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { OperatorTools } from "../../../src/operator/tools.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";

const canRun = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY);

async function makeOperatorTools() {
  const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("telegram", `test-${randomUUID()}`);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) throw new Error("expected a linked user");
  return new OperatorTools(userId, channelIdentityId);
}

describe.skipIf(!canRun)("list_supported_airlines tool (real Postgres, real airlines.json)", () => {
  it("reports every real carrier with an honest submissionMethodType, no fabrication possible", async () => {
    const tools = await makeOperatorTools();

    const result = (await tools.dispatch("list_supported_airlines", {})) as {
      airlines: { carrierIataCode: string; carrierName: string; canAutoSend: boolean; submissionMethodType: string; note: string | null }[];
    };

    expect(result.airlines).toHaveLength(11);

    // Matches the real, currently-verified state of data/airlines.json: no
    // carrier is "email" yet, and only Aer Lingus/TAP are "web_form".
    expect(result.airlines.every((a) => a.canAutoSend === false)).toBe(true);
    expect(result.airlines.every((a) => a.submissionMethodType !== "email")).toBe(true);

    const webFormCarriers = result.airlines.filter((a) => a.submissionMethodType === "web_form").map((a) => a.carrierIataCode).sort();
    expect(webFormCarriers).toEqual(["EI", "TP"]);

    // Every non-email entry must carry a note explaining why — never a bare,
    // unexplained "unsupported" the operator would have to editorialize on.
    for (const airline of result.airlines) {
      if (!airline.canAutoSend) {
        expect(airline.note).toBeTruthy();
      }
    }
  });
});

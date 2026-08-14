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
  it("reports every real carrier and its real routes, with no fabrication possible", async () => {
    const tools = await makeOperatorTools();

    const result = (await tools.dispatch("list_supported_airlines", {})) as {
      airlines: {
        carrierIataCode: string;
        carrierName: string;
        canAutoSend: boolean;
        thirdPartySubmission: string;
        channels: { kind: string; verification: string; url?: string }[];
      }[];
    };

    expect(result.airlines).toHaveLength(11);

    // Still nothing this system can dispatch to on its own. The only email
    // address in the dataset is ITA's PEC legal mailbox, deliberately excluded
    // from auto-send — see submission-plan.ts's findAutoSendChannel.
    expect(result.airlines.every((a) => a.canAutoSend === false)).toBe(true);

    // Every carrier has at least one recorded route, so the operator never has
    // to editorialize about a bare, unexplained "unsupported".
    expect(result.airlines.every((a) => a.channels.length > 0)).toBe(true);

    // Carriers publishing more than one route are exactly the ones the operator
    // must ASK about rather than choosing for the user.
    const multiRoute = result.airlines.filter((a) => a.channels.length > 1).map((a) => a.carrierIataCode).sort();
    expect(multiRoute).toEqual(["AZ", "BA", "LX"]);

    // Ryanair refuses third-party submissions; that must survive to the operator.
    const ryanair = result.airlines.find((a) => a.carrierIataCode === "FR");
    expect(ryanair?.thirdPartySubmission).toBe("restricted");
  });

  it("never hands the operator an address nobody has verified", async () => {
    // Iberia's own research says not to ship its URL without a manual check.
    // The unverified channel variant has no address property at all, so this is
    // a property of the data model rather than a filter that could be forgotten.
    const tools = await makeOperatorTools();

    const result = (await tools.dispatch("list_supported_airlines", {})) as {
      airlines: { carrierIataCode: string; channels: { verification: string; url?: string }[] }[];
    };

    const iberia = result.airlines.find((a) => a.carrierIataCode === "IB");
    expect(iberia?.channels.every((c) => c.verification === "unverified")).toBe(true);
    expect(iberia?.channels.every((c) => c.url === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("iberia.com");
  });
});

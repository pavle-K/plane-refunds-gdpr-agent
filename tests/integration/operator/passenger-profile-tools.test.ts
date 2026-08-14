/**
 * Runs against a real local Postgres, same skip convention as the rest of this
 * repo's integration suite. Covers the passenger-profile store end to end: the
 * two operator tools, the encryption round-trip through the repository, and —
 * the part that actually matters for GDPR — that a forget_my_data request both
 * MENTIONS the profile in its confirmation prompt and DELETES it when confirmed.
 *
 * That last pair is deliberately two separate assertions. forget_my_data
 * enumerates tables by hand in two different methods (the preview and the
 * execution), so a new table can be honoured in one and silently missed in the
 * other — leaving the user told their details were deleted when they weren't.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { env } from "../../../src/config/env.js";
import { OperatorTools } from "../../../src/operator/tools.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { PassengerProfileRepo } from "../../../src/db/repositories/passenger-profile.repo.js";
import { db } from "../../../src/db/client.js";
import { passengerProfiles } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";

const canRun = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY);

const IBAN = "ES9121000418450200051332";

async function makeUser() {
  const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("telegram", `test-${randomUUID()}`);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) throw new Error("expected a linked user");
  return { userId, tools: new OperatorTools(userId, channelIdentityId) };
}

describe.skipIf(!canRun)("passenger profile tools (real Postgres)", () => {
  it("reports nothing saved for a brand-new user", async () => {
    const { tools } = await makeUser();

    const result = (await tools.dispatch("get_passenger_profile", {})) as { saved: boolean; missing: string[] };

    expect(result.saved).toBe(false);
    expect(result.missing).toContain("full name");
  });

  it("saves a profile and reports what is still outstanding", async () => {
    const { tools } = await makeUser();

    await tools.dispatch("save_passenger_profile", { fullName: "Jane Doe", contactEmail: "jane@example.test" });
    const result = (await tools.dispatch("get_passenger_profile", {})) as {
      saved: boolean;
      fullName: string;
      missing: string[];
    };

    expect(result.saved).toBe(true);
    expect(result.fullName).toBe("Jane Doe");
    // Not yet supplied, and the model needs to know to ask rather than assume.
    expect(result.missing).toContain("postal address");
    expect(result.missing).toContain("bank details (IBAN)");
  });

  it("refuses to save without the two fields every claim needs", async () => {
    const { tools } = await makeUser();

    const result = (await tools.dispatch("save_passenger_profile", { phone: "+34 600 000 000" })) as {
      error?: string;
    };

    expect(result.error).toBeTruthy();
  });

  it("merges an update instead of blanking fields the caller omitted", async () => {
    // "Update just my phone number" must not wipe the address. Making the model
    // echo every field back would be the alternative, and echoing is exactly
    // where it would get the chance to alter one.
    const { tools } = await makeUser();

    await tools.dispatch("save_passenger_profile", {
      fullName: "Jane Doe",
      contactEmail: "jane@example.test",
      addressLine1: "1 Example Street",
      city: "Madrid",
    });
    await tools.dispatch("save_passenger_profile", { phone: "+34 600 000 000" });

    const result = (await tools.dispatch("get_passenger_profile", {})) as {
      addressLine1: string | null;
      city: string | null;
      phone: string | null;
    };

    expect(result.addressLine1).toBe("1 Example Street");
    expect(result.city).toBe("Madrid");
    expect(result.phone).toBe("+34 600 000 000");
  });

  it("stores bank details encrypted at rest and returns them decrypted", async () => {
    const { userId, tools } = await makeUser();

    await tools.dispatch("save_passenger_profile", {
      fullName: "Jane Doe",
      contactEmail: "jane@example.test",
      iban: IBAN,
      bic: "CAIXESBBXXX",
    });

    // Straight at the row: the IBAN must not be readable in the column.
    const rows = await db.select().from(passengerProfiles).where(eq(passengerProfiles.userId, userId)).limit(1);
    expect(rows[0]?.encryptedIban).toBeTruthy();
    expect(rows[0]?.encryptedIban).not.toContain(IBAN);
    expect(rows[0]?.encryptedBic).not.toContain("CAIXESBBXXX");

    // Through the repository it round-trips back to plaintext.
    const profile = await new PassengerProfileRepo().findByUserId(userId);
    expect(profile?.iban).toBe(IBAN);
    expect(profile?.bic).toBe("CAIXESBBXXX");
  });

  it("never hands the stored IBAN back through the operator tool", async () => {
    // The model does not need to see an IBAN to tell someone it is saved, and
    // anything it can see it can restate into a chat transcript.
    const { tools } = await makeUser();

    await tools.dispatch("save_passenger_profile", {
      fullName: "Jane Doe",
      contactEmail: "jane@example.test",
      iban: IBAN,
    });
    const result = await tools.dispatch("get_passenger_profile", {});

    expect(JSON.stringify(result)).not.toContain(IBAN);
    expect((result as { hasIban: boolean }).hasIban).toBe(true);
  });

  it("names the profile in the forget_my_data confirmation prompt", async () => {
    const { tools } = await makeUser();
    await tools.dispatch("save_passenger_profile", {
      fullName: "Jane Doe",
      contactEmail: "jane@example.test",
      iban: IBAN,
    });

    const result = (await tools.dispatch("forget_my_data", {})) as { confirmationPrompt: string };

    expect(result.confirmationPrompt).toContain("claim details");
    // Bank details are called out specifically — "your saved details" is too
    // vague for someone deciding whether to confirm an irreversible deletion.
    expect(result.confirmationPrompt).toContain("bank details");
  });

  it("deletes the profile unconditionally when the erasure is confirmed", async () => {
    const { userId, tools } = await makeUser();
    await tools.dispatch("save_passenger_profile", {
      fullName: "Jane Doe",
      contactEmail: "jane@example.test",
      iban: IBAN,
    });

    await tools.executeConfirmedAction("forget_my_data", {});

    expect(await new PassengerProfileRepo().findByUserId(userId)).toBeNull();
  });
});

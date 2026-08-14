import { eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { passengerProfiles } from "../schema.js";
import { encrypt, decrypt } from "../../lib/crypto.js";
import { env } from "../../config/env.js";

/**
 * The profile as the rest of the app sees it — plaintext. Encryption is applied
 * and removed inside this class, so no caller knows or cares that iban/bic are
 * ciphertext at rest.
 *
 * Everything except fullName and contactEmail is optional: a profile is useful
 * long before it's complete. A user can check eligibility and be handed a form
 * URL without ever supplying a postal address or an IBAN — those get asked for
 * only when a specific carrier's form actually requires them (see the prefill
 * resolver in domain/claim/prefill.ts).
 */
export interface PassengerProfile {
  userId: string;
  fullName: string;
  addressLine1?: string | undefined;
  addressLine2?: string | undefined;
  city?: string | undefined;
  postalCode?: string | undefined;
  countryIsoCode?: string | undefined;
  contactEmail: string;
  phone?: string | undefined;
  iban?: string | undefined;
  bic?: string | undefined;
}

/** Everything except the owning user — what a caller supplies to save one. */
export type PassengerProfileInput = Omit<PassengerProfile, "userId">;

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super("TOKEN_ENCRYPTION_KEY must be set to store or read passenger bank details");
    this.name = "MissingEncryptionKeyError";
  }
}

/**
 * Only required when bank details are actually involved. Deliberately not
 * checked on every read: a profile with no IBAN is perfectly usable on a
 * deployment that hasn't configured a key, and failing those reads would take
 * out eligibility checking over a field nobody supplied.
 */
function requireEncryptionKey(): string {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new MissingEncryptionKeyError();
  }
  return env.TOKEN_ENCRYPTION_KEY;
}

function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

/** Bank details are encrypted before insert and decrypted on read — never
 * stored plaintext, same pattern as email_connections' OAuth tokens. */
export class PassengerProfileRepo {
  async findByUserId(userId: string): Promise<PassengerProfile | null> {
    const rows = await db.select().from(passengerProfiles).where(eq(passengerProfiles.userId, userId)).limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }

    const hasBankDetails = row.encryptedIban !== null || row.encryptedBic !== null;
    const key = hasBankDetails ? requireEncryptionKey() : null;

    return {
      userId: row.userId,
      fullName: row.fullName,
      addressLine1: optional(row.addressLine1),
      addressLine2: optional(row.addressLine2),
      city: optional(row.city),
      postalCode: optional(row.postalCode),
      countryIsoCode: optional(row.countryIsoCode),
      contactEmail: row.contactEmail,
      phone: optional(row.phone),
      iban: key && row.encryptedIban ? decrypt(row.encryptedIban, key) : undefined,
      bic: key && row.encryptedBic ? decrypt(row.encryptedBic, key) : undefined,
    };
  }

  /**
   * Full replace, not a partial merge. The caller (OperatorTools) reads the
   * existing profile, applies whatever the user just supplied on top, and
   * writes the whole thing back — so "update just my phone number" is resolved
   * where the conversation context lives, and this method never has to guess
   * whether an absent field means "unchanged" or "clear it". updatedAtUtc uses
   * the DB clock for the same reason EmailConnectionRepo.upsert does.
   */
  async upsert(userId: string, input: PassengerProfileInput): Promise<void> {
    const needsKey = input.iban !== undefined || input.bic !== undefined;
    const key = needsKey ? requireEncryptionKey() : null;
    const encryptedIban = key && input.iban !== undefined ? encrypt(input.iban, key) : null;
    const encryptedBic = key && input.bic !== undefined ? encrypt(input.bic, key) : null;

    const values = {
      fullName: input.fullName,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      postalCode: input.postalCode ?? null,
      countryIsoCode: input.countryIsoCode ?? null,
      contactEmail: input.contactEmail,
      phone: input.phone ?? null,
      encryptedIban,
      encryptedBic,
      updatedAtUtc: sql`now()`,
    };

    await db
      .insert(passengerProfiles)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: [passengerProfiles.userId], set: values });
  }

  /**
   * Unconditional, unlike claim deletion. A profile is not a record of a
   * transaction with a third party — nothing about it needs retaining under
   * GDPR Art. 17(3)'s legal-claims exception, and a claim that WAS sent already
   * carries the name and address inside its stored letter text for the audit
   * trail. So a forget_my_data request takes this in full, every time.
   */
  async deleteForUser(userId: string): Promise<void> {
    await db.delete(passengerProfiles).where(eq(passengerProfiles.userId, userId));
  }
}

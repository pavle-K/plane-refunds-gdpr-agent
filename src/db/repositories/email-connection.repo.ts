import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../client.js";
import { emailConnections } from "../schema.js";
import { encrypt, decrypt } from "../../lib/crypto.js";
import { env } from "../../config/env.js";

export type EmailProviderName = "gmail" | "outlook";

export interface EmailConnection {
  userId: string;
  provider: EmailProviderName;
  emailAddress: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAtUtc: Date;
}

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super("TOKEN_ENCRYPTION_KEY must be set to store or read email connection tokens");
    this.name = "MissingEncryptionKeyError";
  }
}

function requireEncryptionKey(): string {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new MissingEncryptionKeyError();
  }
  return env.TOKEN_ENCRYPTION_KEY;
}

/** Tokens are encrypted before insert and decrypted on read — never stored plaintext. */
export class EmailConnectionRepo {
  /** emailAddress is globally unique (see schema.ts) — an inbox has exactly one
   * current owner. Upserting with a different userId than the existing row's
   * moves ownership to the new caller (they just proved control of the inbox
   * via real OAuth); callers that need to know a reassignment happened and log
   * it should read the existing owner first — this method itself just makes the
   * row match reality. updatedAtUtc uses the DB server's own clock (sql`now()`),
   * not the app server's — this repo's Postgres is remote, and comparing an
   * app-clock timestamp against DB-clock timestamps (e.g. a row's own
   * defaultNow() from insert) is only safe if the two clocks can't skew. */
  async upsert(connection: EmailConnection): Promise<void> {
    const key = requireEncryptionKey();
    const encryptedAccessToken = encrypt(connection.accessToken, key);
    const encryptedRefreshToken = encrypt(connection.refreshToken, key);

    await db
      .insert(emailConnections)
      .values({
        userId: connection.userId,
        provider: connection.provider,
        emailAddress: connection.emailAddress,
        encryptedAccessToken,
        encryptedRefreshToken,
        accessTokenExpiresAtUtc: connection.accessTokenExpiresAtUtc,
        updatedAtUtc: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [emailConnections.emailAddress],
        set: {
          userId: connection.userId,
          provider: connection.provider,
          encryptedAccessToken,
          encryptedRefreshToken,
          accessTokenExpiresAtUtc: connection.accessTokenExpiresAtUtc,
          updatedAtUtc: sql`now()`,
        },
      });
  }

  /** Who (if anyone) currently owns a given mailbox — used by callers that need
   * to detect a reassignment before it happens (see upsert's doc comment). */
  async findByEmailAddress(emailAddress: string): Promise<EmailConnection | null> {
    return this.findOneWhere(eq(emailConnections.emailAddress, emailAddress));
  }

  async findByUserAndProvider(userId: string, provider: EmailProviderName): Promise<EmailConnection | null> {
    return this.findOneWhere(and(eq(emailConnections.userId, userId), eq(emailConnections.provider, provider)));
  }

  private async findOneWhere(condition: SQL | undefined): Promise<EmailConnection | null> {
    const key = requireEncryptionKey();
    const rows = await db.select().from(emailConnections).where(condition).limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      userId: row.userId,
      provider: row.provider as EmailProviderName,
      emailAddress: row.emailAddress,
      accessToken: decrypt(row.encryptedAccessToken, key),
      refreshToken: decrypt(row.encryptedRefreshToken, key),
      accessTokenExpiresAtUtc: row.accessTokenExpiresAtUtc,
    };
  }

  async updateAccessToken(
    provider: EmailProviderName,
    emailAddress: string,
    accessToken: string,
    expiresAtUtc: Date,
  ): Promise<void> {
    const key = requireEncryptionKey();
    await db
      .update(emailConnections)
      .set({
        encryptedAccessToken: encrypt(accessToken, key),
        accessTokenExpiresAtUtc: expiresAtUtc,
        updatedAtUtc: sql`now()`,
      })
      .where(and(eq(emailConnections.provider, provider), eq(emailConnections.emailAddress, emailAddress)));
  }
}

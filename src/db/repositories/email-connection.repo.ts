import { and, eq } from "drizzle-orm";
import { db } from "../client.js";
import { emailConnections } from "../schema.js";
import { encrypt, decrypt } from "../../lib/crypto.js";
import { env } from "../../config/env.js";

export type EmailProviderName = "gmail" | "outlook";

export interface EmailConnection {
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
  async upsert(connection: EmailConnection): Promise<void> {
    const key = requireEncryptionKey();
    const encryptedAccessToken = encrypt(connection.accessToken, key);
    const encryptedRefreshToken = encrypt(connection.refreshToken, key);

    await db
      .insert(emailConnections)
      .values({
        provider: connection.provider,
        emailAddress: connection.emailAddress,
        encryptedAccessToken,
        encryptedRefreshToken,
        accessTokenExpiresAtUtc: connection.accessTokenExpiresAtUtc,
        updatedAtUtc: new Date(),
      })
      .onConflictDoUpdate({
        target: [emailConnections.provider, emailConnections.emailAddress],
        set: {
          encryptedAccessToken,
          encryptedRefreshToken,
          accessTokenExpiresAtUtc: connection.accessTokenExpiresAtUtc,
          updatedAtUtc: new Date(),
        },
      });
  }

  async findByProvider(provider: EmailProviderName): Promise<EmailConnection | null> {
    const key = requireEncryptionKey();
    const rows = await db.select().from(emailConnections).where(eq(emailConnections.provider, provider)).limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
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
        updatedAtUtc: new Date(),
      })
      .where(and(eq(emailConnections.provider, provider), eq(emailConnections.emailAddress, emailAddress)));
  }
}

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, InvalidEncryptionKeyError } from "../../../src/lib/crypto.js";

const KEY = randomBytes(32).toString("base64");

describe("encrypt/decrypt", () => {
  it("round-trips a string", () => {
    const encrypted = encrypt("a refresh token value", KEY);
    expect(decrypt(encrypted, KEY)).toBe("a refresh token value");
  });

  it("produces different ciphertext each time (random IV)", () => {
    const a = encrypt("same input", KEY);
    const b = encrypt("same input", KEY);
    expect(a).not.toBe(b);
  });

  it("does not decrypt with the wrong key", () => {
    const otherKey = randomBytes(32).toString("base64");
    const encrypted = encrypt("secret", KEY);
    expect(() => decrypt(encrypted, otherKey)).toThrow();
  });

  it("throws on a key that isn't 32 bytes", () => {
    const shortKey = randomBytes(16).toString("base64");
    expect(() => encrypt("x", shortKey)).toThrow(InvalidEncryptionKeyError);
  });
});

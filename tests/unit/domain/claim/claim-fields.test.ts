import { describe, it, expect } from "vitest";
import {
  ALL_CLAIM_FIELD_KEYS,
  CLAIM_FIELD_LABELS,
  CLAIM_STATE_FIELD_KEYS,
  PASSENGER_PROFILE_FIELD_KEYS,
  PER_CLAIM_FIELD_KEYS,
  provenanceOf,
} from "../../../../src/domain/claim/claim-fields.js";

describe("claim field vocabulary", () => {
  it("gives every key exactly one provenance", () => {
    // The grouping is what tells the system whether a value is already known,
    // answerable from a stored profile, or has to be asked for. A key in two
    // groups would make that ambiguous.
    const groups = [CLAIM_STATE_FIELD_KEYS, PASSENGER_PROFILE_FIELD_KEYS, PER_CLAIM_FIELD_KEYS];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const key of group) {
        expect(seen.has(key), `${key} appears in more than one provenance group`).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(ALL_CLAIM_FIELD_KEYS.length);
  });

  it("classifies each group correctly", () => {
    expect(provenanceOf("bookingReference")).toBe("claim_state");
    expect(provenanceOf("payoutIban")).toBe("passenger_profile");
    expect(provenanceOf("expenseReceipts")).toBe("per_claim");
  });

  it("gives every key a human-readable label", () => {
    for (const key of ALL_CLAIM_FIELD_KEYS) {
      expect(CLAIM_FIELD_LABELS[key], `${key} has no label`).toBeTruthy();
    }
  });

  it("has no label that is just the key name", () => {
    // Labels are shown to passengers; a raw camelCase key leaking into a
    // sentence reads as a bug even when it is technically accurate.
    for (const key of ALL_CLAIM_FIELD_KEYS) {
      expect(CLAIM_FIELD_LABELS[key]).not.toBe(key);
    }
  });
});

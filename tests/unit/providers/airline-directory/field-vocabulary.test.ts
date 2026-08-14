import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RAW_FIELD_ALIASES,
  RAW_FIELD_TOKENS,
  normaliseRequiredFields,
  type RawFieldToken,
} from "../../../../src/providers/airline-directory/field-vocabulary.js";
import { ALL_CLAIM_FIELD_KEYS } from "../../../../src/domain/claim/claim-fields.js";

const DATA_PATH = fileURLToPath(
  new URL("../../../../src/providers/airline-directory/data/airlines.json", import.meta.url),
);

describe("raw field vocabulary", () => {
  it("maps every raw token used in the shipped dataset", () => {
    // An unmapped token would otherwise be silently dropped from a form's
    // requirements — telling a passenger they have everything they need for a
    // form that will then reject them. The zod enum is derived from this table
    // so it fails at load, but this asserts the table actually covers the data.
    const raw: unknown = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
    const used = new Set<string>();
    for (const carrier of raw as { channels: { requiredFields: string[] | null }[] }[]) {
      for (const channel of carrier.channels) {
        for (const token of channel.requiredFields ?? []) {
          used.add(token);
        }
      }
    }

    expect(used.size).toBeGreaterThan(0);
    for (const token of used) {
      expect(RAW_FIELD_TOKENS, `unmapped raw field token: ${token}`).toContain(token);
    }
  });

  it("only ever maps onto canonical claim field keys", () => {
    for (const [token, keys] of Object.entries(RAW_FIELD_ALIASES)) {
      for (const key of keys) {
        expect(ALL_CLAIM_FIELD_KEYS, `${token} maps to unknown key ${key}`).toContain(key);
      }
    }
  });

  it("fans a bundled token out to every fact behind it", () => {
    // Airlines bundle: one form label, several facts. Expanding them is what
    // lets the prefill resolver know it holds two of the three.
    expect(normaliseRequiredFields(["contactDetails"])).toEqual([
      "claimantEmail",
      "claimantPhone",
      "claimantPostalAddress",
    ]);
    expect(normaliseRequiredFields(["bankAccountDetails"])).toEqual([
      "payoutAccountHolderName",
      "payoutIban",
      "payoutBic",
    ]);
  });

  it("preserves first-seen order and de-duplicates overlapping tokens", () => {
    // British Airways lists both claimantContactDetails and bankAccountDetails;
    // without de-duplication the packet would read "we need your IBAN, and your
    // IBAN".
    const tokens: RawFieldToken[] = ["iban", "bankAccountDetails", "fullName", "claimantName"];
    expect(normaliseRequiredFields(tokens)).toEqual([
      "payoutIban",
      "payoutAccountHolderName",
      "payoutBic",
      "claimantFullName",
    ]);
  });

  it("maps every synonym of the same fact onto one key", () => {
    expect(normaliseRequiredFields(["pnr"])).toEqual(["bookingReference"]);
    expect(normaliseRequiredFields(["bookingReferenceOrETicketNumber"])).toEqual(["bookingReference"]);
    expect(normaliseRequiredFields(["flightSegments"])).toEqual(["flightItinerary"]);
    expect(normaliseRequiredFields(["flightDetails"])).toEqual(["flightItinerary"]);
    expect(normaliseRequiredFields(["issueCategory"])).toEqual(["disruptionType"]);
    expect(normaliseRequiredFields(["irregularityType"])).toEqual(["disruptionType"]);
  });

  it("returns an empty list for no tokens, distinct from unknown fields", () => {
    expect(normaliseRequiredFields([])).toEqual([]);
  });
});

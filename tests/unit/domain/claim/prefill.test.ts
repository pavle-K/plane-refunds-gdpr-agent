import { describe, it, expect } from "vitest";
import { resolvePrefill, hasOutstandingFields } from "../../../../src/domain/claim/prefill.js";
import type { ClaimFieldKey } from "../../../../src/domain/claim/claim-fields.js";

const FACTS = {
  bookingReference: "ELIG7310",
  flightItinerary: "FR725, MAD to PMO, 2026-08-04",
  compensationAmount: "€250",
};

const PROFILE = {
  claimantFullName: "Jane Doe",
  claimantEmail: "jane@example.test",
  claimantPhone: "+34 600 000 000",
  payoutIban: "ES9121000418450200051332",
};

describe("prefill resolver", () => {
  it("fills in every field it holds, in the order the carrier asked for them", () => {
    const required: ClaimFieldKey[] = ["claimantFullName", "bookingReference", "payoutIban"];

    const result = resolvePrefill(required, FACTS, PROFILE);

    expect(result.resolved.map((f) => f.key)).toEqual(["claimantFullName", "bookingReference", "payoutIban"]);
    expect(result.resolved.map((f) => f.value)).toEqual([
      "Jane Doe",
      "ELIG7310",
      "ES9121000418450200051332",
    ]);
    expect(result.complete).toBe(true);
    expect(hasOutstandingFields(result)).toBe(false);
  });

  it("separates what to ask once from what to ask every time", () => {
    // The split is what stops the agent re-asking for an IBAN it already stored,
    // and stops it trying to "remember" a receipt belonging to one disruption.
    const required: ClaimFieldKey[] = ["payoutBic", "expenseReceipts", "claimantPostalAddress"];

    const result = resolvePrefill(required, FACTS, PROFILE);

    expect(result.missingFromProfile.map((f) => f.key)).toEqual(["payoutBic", "claimantPostalAddress"]);
    expect(result.missingPerClaim.map((f) => f.key)).toEqual(["expenseReceipts"]);
    expect(result.complete).toBe(false);
  });

  it("attaches a human-readable label to everything, resolved or missing", () => {
    const result = resolvePrefill(["payoutIban", "payoutBic"], FACTS, PROFILE);

    expect(result.resolved[0]?.label).toBe("bank details (IBAN) for the payout");
    expect(result.missingFromProfile[0]?.label).toBe("your bank's BIC/SWIFT code");
  });

  it("treats a blank or whitespace value as missing, not filled", () => {
    // The old code hardcoded `email: ""` at three construction sites. Rendering
    // that as a satisfied field would be worse than admitting it isn't there.
    const result = resolvePrefill(["claimantEmail", "claimantPhone"], FACTS, {
      claimantEmail: "",
      claimantPhone: "   ",
    });

    expect(result.resolved).toEqual([]);
    expect(result.missingFromProfile.map((f) => f.key)).toEqual(["claimantEmail", "claimantPhone"]);
  });

  it("reports nothing resolved AND nothing missing when the form was never catalogued", () => {
    // null is a statement that nobody has read this carrier's form. Reporting
    // "nothing missing" would imply the form needs nothing; reporting everything
    // missing would invent requirements. It reports neither, and is not complete.
    const result = resolvePrefill(null, FACTS, PROFILE);

    expect(result.resolved).toEqual([]);
    expect(result.missingFromProfile).toEqual([]);
    expect(result.missingPerClaim).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it("is complete for a carrier that genuinely asks for nothing", () => {
    // Distinct from the null case above: an empty list is a real statement.
    const result = resolvePrefill([], FACTS, PROFILE);

    expect(result.complete).toBe(true);
    expect(hasOutstandingFields(result)).toBe(false);
  });

  it("reports an absent claim fact as needing the human, not as filled", () => {
    const result = resolvePrefill(["passengerNames"], FACTS, PROFILE);

    expect(result.resolved).toEqual([]);
    expect(result.missingPerClaim.map((f) => f.key)).toEqual(["passengerNames"]);
  });

  it("does not invent a value for a field the carrier never asked for", () => {
    const result = resolvePrefill(["bookingReference"], FACTS, PROFILE);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved.map((f) => f.key)).not.toContain("claimantFullName");
  });

  it("handles the full British Airways field set against a partial profile", () => {
    // BA is the most demanding carrier in the dataset; this is the realistic
    // shape of a first claim, where bank and co-passenger details are missing.
    const required: ClaimFieldKey[] = [
      "claimantFullName",
      "claimantEmail",
      "claimantPhone",
      "claimantPostalAddress",
      "coPassengerNames",
      "coPassengerContactDetails",
      "bookingReference",
      "flightItinerary",
      "payoutAccountHolderName",
      "payoutIban",
      "payoutBic",
      "expenseReceipts",
    ];

    const result = resolvePrefill(required, FACTS, PROFILE);

    expect(result.resolved.map((f) => f.key)).toEqual([
      "claimantFullName",
      "claimantEmail",
      "claimantPhone",
      "bookingReference",
      "flightItinerary",
      "payoutIban",
    ]);
    expect(result.missingFromProfile.map((f) => f.key)).toEqual([
      "claimantPostalAddress",
      "payoutAccountHolderName",
      "payoutBic",
    ]);
    expect(result.missingPerClaim.map((f) => f.key)).toEqual([
      "coPassengerNames",
      "coPassengerContactDetails",
      "expenseReceipts",
    ]);
  });
});

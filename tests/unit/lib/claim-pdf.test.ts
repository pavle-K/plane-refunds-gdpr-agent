import { describe, it, expect } from "vitest";
import { buildClaimPdf, claimPdfFilename, type ClaimPdfInput } from "../../../src/lib/claim-pdf.js";
import { resolvePrefill } from "../../../src/domain/claim/prefill.js";
import type { ClaimFieldKey } from "../../../src/domain/claim/claim-fields.js";
import { extractPdfText } from "../../../src/lib/pdf-text.js";

const REQUIRED: ClaimFieldKey[] = [
  "claimantFullName",
  "claimantEmail",
  "claimantPostalAddress",
  "bookingReference",
  "payoutIban",
];

function buildInput(overrides: Partial<ClaimPdfInput> = {}): ClaimPdfInput {
  const prefill = resolvePrefill(
    REQUIRED,
    { bookingReference: "XY12ZK" },
    { claimantFullName: "Jane Doe", claimantEmail: "jane@example.test" },
  );

  return {
    carrierName: "British Airways",
    carrierAddressLines: ["British Airways Customer Relations", "PO Box 1126", "Uxbridge", "UB8 9XS"],
    bookingReference: "XY12ZK",
    itineraryLines: ["BA478: BCN -> LHR, 2026-07-02, 245 min delay at arrival"],
    compensationText: "€250",
    eligibilityReason: "Arrival delay of 245 minute(s) meets the 180-minute threshold.",
    prefill,
    todayIso: "2026-08-14",
    ...overrides,
  };
}

describe("claim PDF", () => {
  it("produces a real, non-empty PDF", async () => {
    const buffer = await buildClaimPdf(buildInput());

    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("contains every fact it was given, and none it wasn't", async () => {
    const text = await extractPdfText(await buildClaimPdf(buildInput()));

    expect(text).toContain("XY12ZK");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("British Airways");
    expect(text).toContain("PO Box 1126");
    expect(text).toContain("BA478");
    expect(text).toContain("€250");
    expect(text).toContain("261/2004");
    expect(text).toContain("2026-08-14");
  });

  it("renders an outstanding field as a labelled blank, never as a guess", async () => {
    // A posted claim missing bank details cannot be paid, and the person needs
    // to see that before they seal the envelope — so it must be visible on the
    // page, not silently absent.
    const text = await extractPdfText(await buildClaimPdf(buildInput()));

    expect(text).toContain("To complete before sending");
    expect(text).toContain("bank details (IBAN) for the payout");
    expect(text).toContain("postal address");
    // And nothing invented in their place.
    expect(text).not.toMatch(/ES\d{2}/);
  });

  it("leaves a blank sender block when no claimant name is known", async () => {
    const prefill = resolvePrefill(REQUIRED, { bookingReference: "XY12ZK" }, {});
    const text = await extractPdfText(await buildClaimPdf(buildInput({ prefill })));

    expect(text).toContain("Name:");
    expect(text).not.toContain("Unknown Passenger");
  });

  it("omits the completion section entirely when nothing is outstanding", async () => {
    const prefill = resolvePrefill(
      REQUIRED,
      { bookingReference: "XY12ZK" },
      {
        claimantFullName: "Jane Doe",
        claimantEmail: "jane@example.test",
        claimantPostalAddress: "1 Example Street, Madrid",
        payoutIban: "ES9121000418450200051332",
      },
    );
    const text = await extractPdfText(await buildClaimPdf(buildInput({ prefill })));

    expect(text).not.toContain("To complete before sending");
    expect(text).toContain("ES9121000418450200051332");
  });

  it("always leaves somewhere to sign", async () => {
    const text = await extractPdfText(await buildClaimPdf(buildInput()));
    expect(text).toContain("Signed:");
  });

  it("builds a stable filename and strips anything unsafe from the reference", () => {
    expect(claimPdfFilename("XY12ZK")).toBe("EC261-claim-XY12ZK.pdf");
    expect(claimPdfFilename("../../etc/passwd")).toBe("EC261-claim-etcpasswd.pdf");
    expect(claimPdfFilename("!!!")).toBe("EC261-claim-form.pdf");
  });
});

import PDFDocument from "pdfkit";
import type { PrefillResult } from "../domain/claim/prefill.js";

/**
 * Generates the print-and-post claim form.
 *
 * DETERMINISTIC — no LLM call, exactly like the web-form submission packet in
 * draft-claim.node.ts. Every value here was computed and verified elsewhere in
 * the pipeline; this only lays it out. A claim document is the last place a
 * generated sentence belongs: the letter path is where a fabricated booking
 * reference reached a real user once, and this path has no generative step to
 * fabricate anything with.
 *
 * Anything the system doesn't hold is rendered as a labelled blank rule for the
 * claimant to complete by hand, never as a plausible-looking guess and never
 * silently omitted — a missing IBAN on a posted claim is a claim that cannot be
 * paid, and the person needs to see that before they seal the envelope.
 */

export interface ClaimPdfInput {
  carrierName: string;
  /** The airline's postal address, already verified — see the directory's postal channel. */
  carrierAddressLines: readonly string[];
  bookingReference: string;
  /** One line per flight segment, pre-formatted. */
  itineraryLines: readonly string[];
  compensationText: string;
  eligibilityReason: string | null;
  /** What the system holds and what is still outstanding. */
  prefill: PrefillResult;
  /** Rendered as the letter's date. Injected, never read from the ambient clock. */
  todayIso: string;
}

const PAGE = { size: "A4" as const, margin: 56 };
const BODY_SIZE = 10.5;
const HEADING_SIZE = 15;

function renderDocument(doc: PDFKit.PDFDocument, input: ClaimPdfInput): void {
  const claimantName = input.prefill.resolved.find((f) => f.key === "claimantFullName")?.value;
  const claimantAddress = input.prefill.resolved.find((f) => f.key === "claimantPostalAddress")?.value;
  const claimantEmail = input.prefill.resolved.find((f) => f.key === "claimantEmail")?.value;
  const claimantPhone = input.prefill.resolved.find((f) => f.key === "claimantPhone")?.value;

  // --- sender block -------------------------------------------------------
  doc.fontSize(BODY_SIZE);
  doc.text(claimantName ?? "Name: ______________________________");
  doc.text(claimantAddress ?? "Address: ___________________________________________");
  if (claimantEmail) doc.text(claimantEmail);
  if (claimantPhone) doc.text(claimantPhone);

  // --- addressee ----------------------------------------------------------
  doc.moveDown(1.5);
  doc.text(input.carrierName);
  for (const line of input.carrierAddressLines) {
    doc.text(line);
  }

  doc.moveDown(1.5);
  doc.text(input.todayIso);

  // --- subject ------------------------------------------------------------
  doc.moveDown(1.5);
  doc.fontSize(HEADING_SIZE).text("Compensation claim under Regulation (EC) No 261/2004");
  doc.moveDown(0.5);
  doc.fontSize(BODY_SIZE).text(`Booking reference: ${input.bookingReference}`);

  // --- the claim ----------------------------------------------------------
  doc.moveDown(1.5);
  doc.text("Flight(s):");
  for (const line of input.itineraryLines) {
    doc.text(`    ${line}`);
  }

  doc.moveDown(1);
  doc.text(`Compensation claimed: ${input.compensationText}`);
  if (input.eligibilityReason) {
    doc.moveDown(0.5);
    doc.text(`Basis: ${input.eligibilityReason}`);
  }

  doc.moveDown(1);
  doc.text(
    "I am claiming compensation under Article 7 of Regulation (EC) No 261/2004 in respect of the flight(s) " +
      "above. Please confirm receipt of this claim and the timescale for processing it.",
    { align: "left" },
  );

  // --- details supplied ---------------------------------------------------
  if (input.prefill.resolved.length > 0) {
    doc.moveDown(1.5);
    doc.fontSize(HEADING_SIZE).text("Details");
    doc.moveDown(0.5).fontSize(BODY_SIZE);
    for (const field of input.prefill.resolved) {
      doc.text(`${field.label}: ${field.value}`);
    }
  }

  // --- blanks to complete by hand ----------------------------------------
  const outstanding = [...input.prefill.missingFromProfile, ...input.prefill.missingPerClaim];
  if (outstanding.length > 0) {
    doc.moveDown(1.5);
    doc.fontSize(HEADING_SIZE).text("To complete before sending");
    doc
      .moveDown(0.5)
      .fontSize(BODY_SIZE)
      .text(
        `${input.carrierName} also asks for the following, which I don't have on record for you. ` +
          "Please fill these in by hand before posting — a claim missing bank details cannot be paid.",
      );
    doc.moveDown(0.5);
    for (const field of outstanding) {
      doc.text(`${field.label}: ______________________________________`);
      doc.moveDown(0.3);
    }
  }

  // --- signature ----------------------------------------------------------
  doc.moveDown(2);
  doc.text("Signed: ______________________________     Date: ____________________");
}

/**
 * Renders the form and resolves to the finished PDF bytes. pdfkit is a stream
 * API, so this buffers it — the documents are a page or two, and having the
 * whole thing in memory is what lets it be attached to an email or pushed over
 * a chat channel without a temp file.
 */
export async function buildClaimPdf(input: ClaimPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: PAGE.size, margin: PAGE.margin });

  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  renderDocument(doc, input);
  doc.end();

  return finished;
}

/** Stable, human-meaningful filename for the attachment or chat document. */
export function claimPdfFilename(bookingReference: string): string {
  const safe = bookingReference.replace(/[^A-Za-z0-9-]/g, "");
  return `EC261-claim-${safe || "form"}.pdf`;
}

import type { ClaimFieldKey } from "../../domain/claim/claim-fields.js";

/**
 * Translation table from the raw field names airlines use on their own forms to
 * this project's canonical ClaimFieldKey vocabulary.
 *
 * This lives provider-side, not in domain/, because it is a property of THIS
 * dataset, not of EC261. When the airline research is re-run and a carrier
 * renames a field, only this table changes.
 *
 * One raw token can map to SEVERAL canonical keys — airlines routinely bundle
 * ("contactDetails", "bankAccountDetails"). Expanding them here is what lets
 * the prefill resolver work out that it holds two of the three facts behind a
 * single form label.
 *
 * The zod enum for the raw vocabulary is derived from this table's keys, so a
 * token appearing in airlines.json that nobody has mapped is a LOAD-TIME
 * failure naming the token — never a silently dropped requirement. A dropped
 * requirement would mean confidently telling a passenger they have everything
 * they need for a form that will reject them.
 */
export const RAW_FIELD_ALIASES = {
  // --- Facts the pipeline already holds -----------------------------------
  irregularityType: ["disruptionType"],
  issueCategory: ["disruptionType"],
  flightSegments: ["flightItinerary"],
  flightDetails: ["flightItinerary"],
  bookingReference: ["bookingReference"],
  pnr: ["bookingReference"],
  // Lossy: SWISS accepts either a booking reference OR an e-ticket number, and
  // the booking reference is the one we actually hold. If ticket numbers ever
  // become available at ingest, add a `ticketNumber` claim-state key rather
  // than widening this mapping.
  bookingReferenceOrETicketNumber: ["bookingReference"],
  passengerNames: ["passengerNames"],

  // --- Facts a stored passenger profile can answer ------------------------
  fullName: ["claimantFullName"],
  claimantName: ["claimantFullName"],
  contactEmail: ["claimantEmail"],
  phone: ["claimantPhone"],
  contactDetails: ["claimantEmail", "claimantPhone", "claimantPostalAddress"],
  claimantContactDetails: ["claimantEmail", "claimantPhone", "claimantPostalAddress"],
  iban: ["payoutIban"],
  bic: ["payoutBic"],
  // Lossy: British Airways is a UK carrier and may want sort code + account
  // number rather than IBAN/BIC. This is the EU-shaped approximation; if that
  // turns out to matter, add a `payoutLocalBankDetails` key.
  bankAccountDetails: ["payoutAccountHolderName", "payoutIban", "payoutBic"],

  // --- Facts unique to one disruption -------------------------------------
  claimantRelationship: ["claimantRelationshipToPassenger"],
  // Classified per-claim rather than claim-state even though Booking.passengers
  // exists: OperatorTools.startClaim only ever constructs a single passenger,
  // so treating co-passengers as already known would silently under-report.
  otherPassengerNames: ["coPassengerNames"],
  otherPassengerContactDetails: ["coPassengerContactDetails"],
  expenseReceipts: ["expenseReceipts"],
  receipts: ["expenseReceipts"],
  expenseCurrency: ["expenseCurrency"],
  onwardTravelMethod: ["onwardTravelArrangement"],
  description: ["disruptionDescription"],
} as const satisfies Record<string, readonly ClaimFieldKey[]>;

export type RawFieldToken = keyof typeof RAW_FIELD_ALIASES;

/** Non-empty tuple, because z.enum() requires one. Derived from the table above
 * so the schema and the mapping can never disagree. */
export const RAW_FIELD_TOKENS = Object.keys(RAW_FIELD_ALIASES) as [RawFieldToken, ...RawFieldToken[]];

/**
 * Expands raw tokens to canonical keys, preserving first-seen order and
 * de-duplicating — two raw tokens legitimately overlap (e.g. BA lists both
 * `claimantContactDetails` and `bankAccountDetails`, which would otherwise
 * yield the same key twice and read as "we need your IBAN, and your IBAN").
 */
export function normaliseRequiredFields(raw: readonly RawFieldToken[]): ClaimFieldKey[] {
  const normalised: ClaimFieldKey[] = [];
  for (const token of raw) {
    for (const key of RAW_FIELD_ALIASES[token]) {
      if (!normalised.includes(key)) {
        normalised.push(key);
      }
    }
  }
  return normalised;
}

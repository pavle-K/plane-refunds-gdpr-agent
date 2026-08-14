/**
 * One canonical name per fact a claim submission can ask for.
 *
 * Airlines name the same fact many different ways — "pnr", "bookingReference"
 * and "bookingReferenceOrETicketNumber" are one field; "iban" and
 * "bankAccountDetails" are another. Those carrier-specific spellings are
 * normalised onto these keys at data-load time (see
 * providers/airline-directory/field-vocabulary.ts), so nothing downstream ever
 * branches on one airline's vocabulary.
 *
 * This lives in domain/ rather than in the airline-directory provider on
 * purpose: the passenger-profile store names its own columns after these keys,
 * and a database table should not have to import a provider type to do that.
 * It is pure data — no I/O, no clock — so it is trivially testable.
 *
 * Grouped by PROVENANCE — who can actually answer the question — because that
 * is the only grouping the prefill resolver cares about:
 *
 *   claim_state       already known to the pipeline; never ask the human
 *   passenger_profile answerable from the stored profile, once collected
 *   per_claim         unique to this disruption; must be asked every time
 */

/** Facts the pipeline already holds by the time a claim is drafted. */
export const CLAIM_STATE_FIELD_KEYS = [
  "bookingReference",
  "flightItinerary",
  "disruptionType",
  "passengerNames",
  "compensationAmount",
] as const;

/** Facts about the person claiming — collected once, then reused. */
export const PASSENGER_PROFILE_FIELD_KEYS = [
  "claimantFullName",
  "claimantEmail",
  "claimantPhone",
  "claimantPostalAddress",
  "payoutAccountHolderName",
  "payoutIban",
  "payoutBic",
] as const;

/** Facts specific to one disruption; no stored profile can supply them. */
export const PER_CLAIM_FIELD_KEYS = [
  "claimantRelationshipToPassenger",
  "coPassengerNames",
  "coPassengerContactDetails",
  "expenseReceipts",
  "expenseCurrency",
  "onwardTravelArrangement",
  "disruptionDescription",
] as const;

export type ClaimStateFieldKey = (typeof CLAIM_STATE_FIELD_KEYS)[number];
export type PassengerProfileFieldKey = (typeof PASSENGER_PROFILE_FIELD_KEYS)[number];
export type PerClaimFieldKey = (typeof PER_CLAIM_FIELD_KEYS)[number];
export type ClaimFieldKey = ClaimStateFieldKey | PassengerProfileFieldKey | PerClaimFieldKey;

/**
 * The single source of truth the zod enum is derived from as well. The previous
 * `z.enum(["fullName", ...])` in static.adapter.ts was hand-written alongside a
 * separate `PassengerFieldKey` union and could drift from it without any
 * compile error; deriving both from this array makes that drift impossible.
 */
export const ALL_CLAIM_FIELD_KEYS = [
  ...CLAIM_STATE_FIELD_KEYS,
  ...PASSENGER_PROFILE_FIELD_KEYS,
  ...PER_CLAIM_FIELD_KEYS,
] as const satisfies readonly ClaimFieldKey[];

export type ClaimFieldProvenance = "claim_state" | "passenger_profile" | "per_claim";

const PROVENANCE: ReadonlyMap<ClaimFieldKey, ClaimFieldProvenance> = new Map<ClaimFieldKey, ClaimFieldProvenance>([
  ...CLAIM_STATE_FIELD_KEYS.map((key) => [key, "claim_state"] as const),
  ...PASSENGER_PROFILE_FIELD_KEYS.map((key) => [key, "passenger_profile"] as const),
  ...PER_CLAIM_FIELD_KEYS.map((key) => [key, "per_claim"] as const),
]);

export function provenanceOf(key: ClaimFieldKey): ClaimFieldProvenance {
  const provenance = PROVENANCE.get(key);
  if (provenance === undefined) {
    throw new Error(`Unclassified claim field key: ${key}`);
  }
  return provenance;
}

/**
 * Human-readable labels, used when telling someone what a form will ask them
 * for. Exhaustive by type: adding a key without a label is a compile error.
 */
export const CLAIM_FIELD_LABELS: Record<ClaimFieldKey, string> = {
  bookingReference: "booking reference",
  flightItinerary: "flight number(s), date and route",
  disruptionType: "what went wrong (delay or cancellation)",
  passengerNames: "the name of every passenger on the booking",
  compensationAmount: "the compensation amount being claimed",

  claimantFullName: "full name",
  claimantEmail: "contact email",
  claimantPhone: "phone number",
  claimantPostalAddress: "postal address",
  payoutAccountHolderName: "the account holder's name",
  payoutIban: "bank details (IBAN) for the payout",
  payoutBic: "your bank's BIC/SWIFT code",

  claimantRelationshipToPassenger: "your relationship to the passenger, if you aren't the passenger",
  coPassengerNames: "the other passengers' names",
  coPassengerContactDetails: "the other passengers' contact details",
  expenseReceipts: "receipts for any out-of-pocket expenses",
  expenseCurrency: "the currency those expenses were in",
  onwardTravelArrangement: "how you eventually got to your destination",
  disruptionDescription: "a short description of what happened",
};

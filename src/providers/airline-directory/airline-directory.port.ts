import type { Result } from "../../lib/result.js";

/**
 * Facts a claim submission might need to supply, beyond what's already
 * computed elsewhere (booking reference, flight facts, compensation amount).
 * Named so a future passenger-profile store can use these same keys as its
 * field names — this typology is what tells the agent which of a profile's
 * fields a given airline's submission actually requires, not just that "some
 * personal info" is needed.
 */
export type PassengerFieldKey = "fullName" | "address" | "contactEmail" | "phone" | "iban";

/**
 * How a claim actually gets to a given airline — deliberately NOT just an
 * email address. Several airlines (Ryanair among them) don't accept EC261
 * claims by email at all; they require their own web form. Modeling this as a
 * discriminated union means "we don't know yet" is its own explicit state
 * (`unsupported`), not a guessed/placeholder value masquerading as real data —
 * same philosophy as distance.ts's UnknownAirportError: an unknown fact must
 * fail loudly, never silently default to something that looks plausible.
 *
 * `web_form` is deliberately NOT something this codebase submits
 * automatically (see the "self-updating submission agent" GitHub issue) —
 * driving a third party's own UI is a materially bigger, riskier feature
 * (ToS, anti-bot, silent breakage on redesign) than sending an email, so for
 * now it's a signal to hand the human the letter + link, not a send path.
 */
export type ClaimSubmissionMethod =
  | { type: "email"; claimsEmail: string; requiredFields: PassengerFieldKey[] }
  | { type: "web_form"; formUrl: string; requiredFields: PassengerFieldKey[]; formNotes?: string | undefined }
  | { type: "unsupported"; reason: string };

export interface AirlineClaimsContact {
  carrierIataCode: string;
  carrierName: string;
  /** True if the OPERATING carrier is an EU airline for EC261 route-coverage purposes. */
  isEuCarrier: boolean;
  submissionMethod: ClaimSubmissionMethod;
  /** Short descriptive tags for boilerplate rejection patterns seen from this carrier. */
  knownRejectionPatterns: string[];
}

export type AirlineDirectoryError = { type: "not_found"; message: string };

export interface AirlineDirectoryProvider {
  getAirline(carrierIataCode: string): Promise<Result<AirlineClaimsContact, AirlineDirectoryError>>;

  /**
   * Every known carrier, so a general question like "which airlines can this
   * actually send to automatically?" has a real, grounded answer instead of
   * inviting the operator LLM to guess — see OperatorTools.listSupportedAirlines
   * and its list_supported_airlines tool. Not wrapped in Result: there's no
   * meaningful per-call failure mode for "list everything this adapter has,"
   * same convention as ClaimRepo.findAllForUser.
   */
  listAirlines(): Promise<AirlineClaimsContact[]>;
}

import type { Result } from "../../lib/result.js";
import type { ClaimFieldKey } from "../../domain/claim/claim-fields.js";

/**
 * Whether this carrier accepts a claim filed by anyone other than the passenger
 * themselves. A stance of the airline, so it sits on the carrier rather than on
 * one channel.
 *
 * Typed, never prose: every user-facing sentence about it is rendered from this
 * enum by submission-plan.ts. A maintainer's note can therefore never be the
 * thing that explains it to a passenger.
 *
 * - `allowed` — no published restriction.
 * - `requires_authorization` — a signed letter of authority is needed. British
 *   Airways, Lufthansa and Aer Lingus all say so explicitly.
 * - `restricted` — the carrier actively blocks intermediaries. Ryanair runs a
 *   mandatory registration scheme for claims-management companies and has
 *   litigated to force claims through its own channel; its terms require the
 *   passenger to file directly.
 */
export type ThirdPartySubmissionPolicy = "allowed" | "requires_authorization" | "restricted";

/**
 * How much trust a channel's contact details have actually earned. This GATES
 * whether an address is ever shown to a passenger — the dataset contains
 * entries whose own research says, in so many words, "do not ship this URL to
 * users without a manual check".
 *
 * - `verified` — someone loaded it and confirmed it is the EC261 channel.
 * - `partially_verified` — it exists and is official, but something about it is
 *   unconfirmed (a locale-specific path, a redirect chain, a form behind a
 *   button whose target could not be read).
 * - `unverified` — a plausible candidate nobody has actually loaded.
 */
export type ConfirmedVerification = "verified" | "partially_verified";
export type VerificationStatus = ConfirmedVerification | "unverified";

export type ClaimChannelKind = "web_form" | "email" | "postal";

/**
 * `{ known: false }` is NOT the same as an empty field list. Five carriers in
 * the dataset have no catalogued fields at all, because their forms are
 * JS-rendered and could not be read. Telling a passenger "this form asks for
 * nothing" about a form that demands eight fields is the same class of error as
 * guessing a claims address — so the absence of knowledge is modelled
 * explicitly, exactly as distance.ts refuses to default an unknown airport to
 * zero.
 */
export type RequiredFields =
  | { readonly known: true; readonly fields: readonly ClaimFieldKey[] }
  | { readonly known: false };

export interface PostalAddress {
  readonly lines: readonly string[];
  readonly countryIsoCode: string;
}

interface ClaimChannelCommon {
  /**
   * Stable handle (`"BA#0"`), assigned at load time from the carrier code and
   * the channel's index. Exists so "which of these do you want to use?" can be
   * answered by an id, rather than by the model re-describing a channel back to
   * us in its own words.
   */
  readonly id: string;
  /** ISO date (YYYY-MM-DD) a maintainer last checked this channel. */
  readonly lastCheckedOn: string;
  readonly requiredFields: RequiredFields;
  /**
   * Short, curated, user-safe copy — the only free text on this type. The
   * schema rejects any line containing a URL, bare hostname or email address,
   * because a channel's address must come from a typed field that a human
   * verified, never from a sentence.
   */
  readonly guidance: readonly string[];
}

/**
 * Note the shape: an unverified channel has NO address property at all — not
 * null, absent. There is nowhere to put an address nobody has loaded, so
 * "the agent shipped an unchecked URL" is not a representable program state.
 * That is the Iberia case handled by the type system instead of by an `if`
 * someone can later forget to write.
 */
export type WebFormChannel =
  | (ClaimChannelCommon & {
      readonly kind: "web_form";
      readonly verification: ConfirmedVerification;
      /** Absolute and fully resolved — any {market}/{lang} template was
       * substituted at load time, and a surviving placeholder is a load error. */
      readonly url: string;
    })
  | (ClaimChannelCommon & { readonly kind: "web_form"; readonly verification: "unverified" });

export type EmailChannel =
  | (ClaimChannelCommon & {
      readonly kind: "email";
      readonly verification: ConfirmedVerification;
      readonly address: string;
      /**
       * A PEC (posta elettronica certificata) address is Italy's registered-post
       * equivalent and is not reachable from an ordinary mailbox — ITA Airways
       * publishes one, but it is their corporate legal address, not their claims
       * desk. Typed so sendClaim can refuse it structurally rather than firing an
       * automated first-instance claim into a legal inbox.
       */
      readonly mailbox: "standard" | "pec";
    })
  | (ClaimChannelCommon & { readonly kind: "email"; readonly verification: "unverified" });

export type PostalChannel =
  | (ClaimChannelCommon & {
      readonly kind: "postal";
      readonly verification: ConfirmedVerification;
      readonly address: PostalAddress;
    })
  | (ClaimChannelCommon & { readonly kind: "postal"; readonly verification: "unverified" });

export type ClaimChannel = WebFormChannel | EmailChannel | PostalChannel;

/** An email channel that actually carries an address. The only shape anything
 * may attempt to dispatch to — see SubmissionPlan.autoSendChannel. */
export type ConfirmedEmailChannel = Extract<EmailChannel, { address: string }>;

/** Narrowing helper: true when a channel carries usable contact details. */
export function isConfirmed(
  channel: ClaimChannel,
): channel is Extract<ClaimChannel, { verification: ConfirmedVerification }> {
  return channel.verification !== "unverified";
}

/**
 * INVARIANT: every string field on this type is either an enum-adjacent
 * identifier, a verified address, or has passed the schema's user-facing-copy
 * check. Nothing here may carry maintainer research — that lives on a separate
 * type in maintenance.ts, which this provider's public interface cannot reach.
 */
export interface AirlineClaimsContact {
  readonly carrierIataCode: string;
  readonly carrierName: string;
  /** True if the OPERATING carrier is an EU airline for EC261 route-coverage purposes. */
  readonly isEuCarrier: boolean;
  readonly thirdPartySubmission: ThirdPartySubmissionPolicy;
  /**
   * Ordered by maintainer preference, best first.
   *
   * Deliberately NOT a `primary: true` flag — a primary marker is an invitation
   * to silently pick one. Ordering is a presentation hint only; what a caller is
   * allowed to DO with several channels is decided by ChannelSelection in
   * submission-plan.ts, which gives no default to reach for when there is more
   * than one.
   */
  readonly channels: readonly ClaimChannel[];
  /** Short user-safe tags for boilerplate rejection patterns seen from this carrier. */
  readonly knownRejectionPatterns: readonly string[];
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

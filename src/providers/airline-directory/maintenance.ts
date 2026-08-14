import type { VerificationStatus } from "./airline-directory.port.js";

/**
 * Everything a maintainer needs to know about how a carrier's entry was
 * researched — and nothing a passenger or a language model should ever see.
 *
 * This is a separate type, in a separate module, reached through a separate
 * interface that index.ts deliberately does NOT re-export.
 *
 * The reason is a real incident. Ryanair's directory entry carried a `reason`
 * string containing an unconfirmed URL (eu261claims.ryanair.com) alongside the
 * developer-facing instruction "do not encode this URL as fact until someone
 * has actually loaded it". That string travelled
 * `submissionMethod.reason` -> `submissionWarning` -> `summarize()` ->
 * `JSON.stringify` -> the operator model, which read the URL as source
 * material and told a user to "submit manually using their web form" — a
 * channel that did not exist in the data. The prose was written for a
 * colleague; the model had no way to know that.
 *
 * Better prompting was not the fix. The fix is that the type a node or an
 * operator tool receives (AirlineDirectoryProvider) has no member that returns
 * any of this, so no amount of serialisation downstream can reach it.
 */
export interface ChannelResearch {
  /** Which channel on the carrier this belongs to, matching ClaimChannel.id. */
  readonly channelId: string;
  /** How the check was performed. */
  readonly verificationMethod: string;
  readonly verificationStatus: VerificationStatus;
  /** Caveats on the check — locale quirks, what was and wasn't confirmed. */
  readonly verificationNote?: string | undefined;
  /** The long-form research prose. Written for a maintainer, not a passenger. */
  readonly notes?: string | undefined;
  /**
   * Addresses that exist in the source data but are deliberately NOT public:
   * candidates for an unverified channel, and the non-chosen URL where a
   * carrier publishes both an entry point and a deeper form target.
   */
  readonly candidateUrls: readonly string[];
}

export interface CarrierResearch {
  readonly carrierIataCode: string;
  /** Carrier-level research not tied to one channel. */
  readonly notes?: string | undefined;
  readonly channels: readonly ChannelResearch[];
  /**
   * Explicit statements that a channel does NOT exist — distinct from simply
   * having no entry for it. Turkish Airlines publishes no complaints email at
   * all and addresses circulating online are not official; recording that as a
   * negative assertion stops it being "rediscovered" and helpfully used later.
   */
  readonly excludedChannels: readonly { readonly kind: string; readonly reason: string }[];
}

/**
 * Read access to the research side of the directory.
 *
 * Deliberately NOT part of AirlineDirectoryProvider and NOT exported from
 * index.ts. Nodes and OperatorTools are handed an AirlineDirectoryProvider,
 * whose static type has no `getResearch`. Anything that genuinely needs this
 * (a maintenance report, a data-quality script) must import this module by
 * path and say so explicitly.
 */
export interface AirlineDirectoryMaintenanceView {
  getResearch(carrierIataCode: string): Promise<CarrierResearch | null>;
}

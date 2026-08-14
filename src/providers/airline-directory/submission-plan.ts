import type { Result } from "../../lib/result.js";
import { CLAIM_FIELD_LABELS } from "../../domain/claim/claim-fields.js";
import type { ClaimFieldKey } from "../../domain/claim/claim-fields.js";
import {
  isConfirmed,
  type AirlineClaimsContact,
  type AirlineDirectoryError,
  type ClaimChannel,
  type ClaimChannelKind,
  type ConfirmedEmailChannel,
  type PostalAddress,
  type ThirdPartySubmissionPolicy,
  type VerificationStatus,
} from "./airline-directory.port.js";

/**
 * Why no channel is usable. Distinguished because they mean different things to
 * a passenger: "we don't cover this airline" is final, "we haven't confirmed
 * their form yet" is a gap on our side.
 */
export type NoChannelReason = "carrier_not_in_directory" | "no_channel_recorded" | "only_unverified_channels";

/**
 * Note there is no "preferred" or "default" member on `choice_required`. That
 * is the point: when a carrier publishes more than one usable channel, a caller
 * has nothing to silently reach for and must put the choice to the human.
 */
export type ChannelSelection =
  | { readonly type: "single"; readonly channel: ClaimChannel }
  | { readonly type: "choice_required"; readonly options: readonly ClaimChannel[] }
  | { readonly type: "none_available"; readonly reason: NoChannelReason };

/** A channel flattened for presentation. Carries no research and no unverified address. */
export interface PresentableChannel {
  readonly id: string;
  readonly kind: ClaimChannelKind;
  readonly label: string;
  readonly verification: VerificationStatus;
  readonly url?: string | undefined;
  readonly emailAddress?: string | undefined;
  readonly postalAddress?: readonly string[] | undefined;
  /** Null when nobody has catalogued this form's fields — distinct from an empty list. */
  readonly requiredFieldLabels: readonly string[] | null;
  readonly requiredFieldKeys: readonly ClaimFieldKey[] | null;
  readonly guidance: readonly string[];
}

export interface SubmissionPlan {
  readonly carrierIataCode: string;
  readonly carrierName: string | null;
  readonly thirdPartySubmission: ThirdPartySubmissionPolicy | null;
  readonly selection: ChannelSelection;
  readonly channels: readonly PresentableChannel[];
  /**
   * Non-null ONLY for a confirmed, standard-mailbox email channel on a carrier
   * that permits third-party submission. This is the single thing sendClaim and
   * humanApproval branch on — neither re-derives it, so there is one definition
   * of "can this actually be dispatched" in the codebase.
   */
  readonly autoSendChannel: ConfirmedEmailChannel | null;
  /**
   * Rendered from the enums above by code in this file. Contains no free text
   * from the dataset except carrierName, a confirmed address, and curated
   * `guidance` lines that the schema has already checked for addresses. This is
   * what the operator is instructed to relay.
   */
  readonly message: string;
}

const KIND_LABELS: Record<ClaimChannelKind, string> = {
  web_form: "their own web form",
  email: "email",
  postal: "post",
};

function formatPostalAddress(address: PostalAddress): string[] {
  return [...address.lines];
}

export function toPresentableChannel(channel: ClaimChannel): PresentableChannel {
  const requiredFieldKeys = channel.requiredFields.known ? channel.requiredFields.fields : null;

  return {
    id: channel.id,
    kind: channel.kind,
    label: KIND_LABELS[channel.kind],
    verification: channel.verification,
    requiredFieldKeys,
    requiredFieldLabels: requiredFieldKeys === null ? null : requiredFieldKeys.map((key) => CLAIM_FIELD_LABELS[key]),
    guidance: channel.guidance,
    ...(isConfirmed(channel) && channel.kind === "web_form" ? { url: channel.url } : {}),
    ...(isConfirmed(channel) && channel.kind === "email" ? { emailAddress: channel.address } : {}),
    ...(isConfirmed(channel) && channel.kind === "postal" ? { postalAddress: formatPostalAddress(channel.address) } : {}),
  };
}

/** A carrier stripped to what the operator may be told about it. */
export interface OperatorAirlineView {
  readonly carrierIataCode: string;
  readonly carrierName: string;
  readonly canAutoSend: boolean;
  readonly thirdPartySubmission: ThirdPartySubmissionPolicy;
  readonly channels: readonly PresentableChannel[];
}

export function toOperatorAirlineView(contact: AirlineClaimsContact): OperatorAirlineView {
  return {
    carrierIataCode: contact.carrierIataCode,
    carrierName: contact.carrierName,
    canAutoSend: findAutoSendChannel(contact) !== null,
    thirdPartySubmission: contact.thirdPartySubmission,
    channels: contact.channels.map(toPresentableChannel),
  };
}

/**
 * "Can we dispatch this ourselves?" — deliberately conservative on three counts,
 * each of which has a real carrier behind it:
 *  - the channel must be email (a web form needs a human, per issue #8);
 *  - the mailbox must be `standard`, not a PEC legal address (ITA Airways);
 *  - the carrier must permit third-party filing (Ryanair does not).
 */
function findAutoSendChannel(contact: AirlineClaimsContact): ConfirmedEmailChannel | null {
  if (contact.thirdPartySubmission === "restricted") {
    return null;
  }
  for (const channel of contact.channels) {
    if (channel.kind === "email" && isConfirmed(channel) && channel.mailbox === "standard") {
      return channel;
    }
  }
  return null;
}

function describeThirdParty(policy: ThirdPartySubmissionPolicy, carrierName: string): string | null {
  switch (policy) {
    case "allowed":
      return null;
    case "requires_authorization":
      return (
        `${carrierName} will also want a signed letter authorising someone else to claim on your behalf, ` +
        "if you aren't submitting it yourself."
      );
    case "restricted":
      return (
        `${carrierName} only accepts claims filed by the passenger directly — they don't accept submissions ` +
        "from third parties acting on your behalf, so this one has to go in under your own name."
      );
  }
}

function describeRequiredFields(channel: PresentableChannel): string {
  if (channel.requiredFieldLabels === null) {
    return "I haven't been able to catalogue exactly which fields they ask for, so work through their form as it comes.";
  }
  if (channel.requiredFieldLabels.length === 0) {
    return "";
  }
  return `You'll need: ${channel.requiredFieldLabels.join(", ")}.`;
}

function describeChannel(channel: PresentableChannel): string {
  const parts: string[] = [];

  if (channel.kind === "web_form" && channel.url) {
    parts.push(`Submit it here:\n${channel.url}`);
  } else if (channel.kind === "email" && channel.emailAddress) {
    parts.push(`This one goes by email, to: ${channel.emailAddress}`);
  } else if (channel.kind === "postal" && channel.postalAddress) {
    parts.push(`By post, to:\n${channel.postalAddress.join("\n")}`);
  }

  if (channel.verification === "partially_verified") {
    parts.push(
      "That's their confirmed starting point — you may need one more click from there to reach the form itself.",
    );
  }

  parts.push(...channel.guidance);

  const fields = describeRequiredFields(channel);
  if (fields) {
    parts.push(fields);
  }

  return parts.join("\n\n");
}

function describeNoChannel(reason: NoChannelReason, carrierName: string | null): string {
  switch (reason) {
    case "carrier_not_in_directory":
      return "Sorry — this airline isn't supported at the moment. I don't have a verified way to submit a claim to them.";
    case "no_channel_recorded":
      return (
        `Sorry — ${carrierName ?? "this airline"} isn't supported at the moment. I don't have a recorded ` +
        "submission channel for them."
      );
    case "only_unverified_channels":
      return (
        `I know ${carrierName ?? "this airline"} handles EC261 claims, but I haven't been able to confirm ` +
        "their submission channel, so I won't hand you an address that might be wrong. This one needs to be " +
        "checked by hand before I can help you file it."
      );
  }
}

function renderMessage(
  selection: ChannelSelection,
  carrierName: string | null,
  thirdParty: ThirdPartySubmissionPolicy | null,
): string {
  if (selection.type === "none_available") {
    return describeNoChannel(selection.reason, carrierName);
  }

  const name = carrierName ?? "This airline";
  const sections: string[] = [];

  if (selection.type === "single") {
    const channel = toPresentableChannel(selection.channel);
    sections.push(
      channel.kind === "email"
        ? `${name} accepts EC261 claims by email.`
        : `${name} handles EC261 claims through ${KIND_LABELS[channel.kind]}, so this has to be submitted by hand — ` +
          "I can't do that step for you yet.",
    );
    sections.push(describeChannel(channel));
  } else {
    const options = selection.options.map(toPresentableChannel);
    sections.push(
      `${name} offers more than one way to submit this: ${options.map((o) => o.label).join(" and ")}. ` +
        "Which would you like to use? You can do both if you'd rather have a paper record as well.",
    );
    for (const option of options) {
      sections.push(`--- Via ${option.label} ---\n${describeChannel(option)}`);
    }
  }

  if (thirdParty) {
    const note = describeThirdParty(thirdParty, name);
    if (note) {
      sections.push(note);
    }
  }

  return sections.filter(Boolean).join("\n\n");
}

/**
 * Turns a directory lookup into everything the rest of the system needs to
 * decide what happens next, and everything the operator needs to say about it.
 * Both are produced here, together, so the structured decision and the sentence
 * explaining it can never disagree.
 */
export function buildSubmissionPlan(
  carrierIataCode: string,
  lookup: Result<AirlineClaimsContact, AirlineDirectoryError>,
): SubmissionPlan {
  if (!lookup.ok) {
    return {
      carrierIataCode,
      carrierName: null,
      thirdPartySubmission: null,
      selection: { type: "none_available", reason: "carrier_not_in_directory" },
      channels: [],
      autoSendChannel: null,
      message: describeNoChannel("carrier_not_in_directory", null),
    };
  }

  const contact = lookup.value;
  const usable = contact.channels.filter(isConfirmed);

  const selection: ChannelSelection =
    contact.channels.length === 0
      ? { type: "none_available", reason: "no_channel_recorded" }
      : usable.length === 0
        ? { type: "none_available", reason: "only_unverified_channels" }
        : usable.length === 1
          ? { type: "single", channel: usable[0]! }
          : { type: "choice_required", options: usable };

  return {
    carrierIataCode: contact.carrierIataCode,
    carrierName: contact.carrierName,
    thirdPartySubmission: contact.thirdPartySubmission,
    selection,
    channels: contact.channels.map(toPresentableChannel),
    autoSendChannel: findAutoSendChannel(contact),
    message: renderMessage(selection, contact.carrierName, contact.thirdPartySubmission),
  };
}

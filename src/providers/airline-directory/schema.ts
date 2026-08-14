import { z } from "zod";
import type {
  AirlineClaimsContact,
  ClaimChannel,
  ConfirmedVerification,
  RequiredFields,
} from "./airline-directory.port.js";
import type { CarrierResearch, ChannelResearch } from "./maintenance.js";
import { RAW_FIELD_TOKENS, normaliseRequiredFields } from "./field-vocabulary.js";
import { TEMPLATE_PLACEHOLDERS, placeholdersIn, resolveTemplatedUrl } from "./url-template.js";

/**
 * Anything that could read as "here is where to send it": a URL, a bare
 * hostname, or an email address. User-facing copy that trips this is a LOAD
 * ERROR, not a lint warning.
 *
 * This is the schema-level half of the anti-leak design. The Ryanair prose that
 * caused a fabricated channel — "a dedicated claims subdomain
 * (eu261claims.ryanair.com) ... do not encode this URL as fact" — could not be
 * a `guidance` line under this rule. It can only be `research`, which the
 * public port type has nowhere to carry.
 */
const LOOKS_LIKE_AN_ADDRESS = /(https?:\/\/|www\.|@|\b[a-z0-9][a-z0-9-]*\.[a-z]{2,}\b)/i;

const userFacingLine = z
  .string()
  .min(1)
  .max(240)
  .refine((line) => !LOOKS_LIKE_AN_ADDRESS.test(line), {
    message:
      "user-facing copy must not contain a URL, hostname or email address — put it in `research` instead, " +
      "and let the typed address fields carry the address",
  });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)");

const verificationSchema = z.strictObject({
  status: z.enum(["verified", "partially_verified", "unverified"]),
  date: isoDate,
  /** Maintainer-only — split off by toLoadedCarrier, never reaches the port type. */
  method: z.string().min(1),
  /** Maintainer-only. */
  note: z.string().min(1).optional(),
});

/**
 * `null` is a deliberate statement that nobody has catalogued this form's
 * fields. The key is REQUIRED (strictObject, not optional), so "unknown" always
 * has to be written down on purpose rather than arrived at by omission.
 */
const requiredFieldsSchema = z.array(z.enum(RAW_FIELD_TOKENS)).nullable();

const channelCommon = {
  verification: verificationSchema,
  requiredFields: requiredFieldsSchema,
  guidance: z.array(userFacingLine).max(4).default([]),
  /** Maintainer research prose. Several hundred words is normal here. */
  research: z.string().min(1).optional(),
};

const webFormChannelSchema = z
  .strictObject({
    kind: z.literal("web_form"),
    ...channelCommon,
    url: z.url().optional(),
    urlTemplate: z.string().optional(),
    /** Must supply a value for every placeholder in urlTemplate. */
    urlTemplateValues: z.record(z.string(), z.string()).optional(),
    /** A documented entry point that redirects to the form (Turkish Airlines).
     * When present this is what a passenger is given, because it is the address
     * they can actually navigate to. */
    entryUrl: z.url().optional(),
  })
  .superRefine((channel, ctx) => {
    const hasSomeUrl = Boolean(channel.url ?? channel.urlTemplate ?? channel.entryUrl);
    if (channel.verification.status !== "unverified" && !hasSomeUrl) {
      ctx.addIssue({
        code: "custom",
        message: "a confirmed web_form channel must carry a url, urlTemplate or entryUrl",
      });
    }
    if (channel.urlTemplate) {
      for (const placeholder of placeholdersIn(channel.urlTemplate)) {
        if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(placeholder)) {
          ctx.addIssue({ code: "custom", message: `unknown url template placeholder {${placeholder}}` });
        }
        if (channel.urlTemplateValues?.[placeholder] === undefined) {
          ctx.addIssue({ code: "custom", message: `urlTemplateValues is missing "${placeholder}"` });
        }
      }
    }
  });

const emailChannelSchema = z
  .strictObject({
    kind: z.literal("email"),
    ...channelCommon,
    address: z.email().optional(),
    mailbox: z.enum(["standard", "pec"]).default("standard"),
  })
  .superRefine((channel, ctx) => {
    if (channel.verification.status !== "unverified" && !channel.address) {
      ctx.addIssue({ code: "custom", message: "a confirmed email channel must carry an address" });
    }
  });

const postalAddressSchema = z.strictObject({
  lines: z.array(z.string().min(1)).min(2),
  countryIsoCode: z.string().length(2),
});

const postalChannelSchema = z
  .strictObject({
    kind: z.literal("postal"),
    ...channelCommon,
    address: postalAddressSchema.optional(),
  })
  .superRefine((channel, ctx) => {
    if (channel.verification.status !== "unverified" && !channel.address) {
      ctx.addIssue({ code: "custom", message: "a confirmed postal channel must carry an address" });
    }
  });

const channelSchema = z.discriminatedUnion("kind", [webFormChannelSchema, emailChannelSchema, postalChannelSchema]);

const excludedChannelSchema = z.strictObject({
  kind: z.enum(["web_form", "email", "postal"]),
  /** Maintainer-facing: why this channel is known not to exist. */
  reason: z.string().min(1),
});

const carrierSchema = z.strictObject({
  carrierIataCode: z.string().regex(/^[A-Z0-9]{2}$/, "must be a 2-character uppercase IATA carrier code"),
  carrierName: userFacingLine.max(80),
  isEuCarrier: z.boolean(),
  thirdPartySubmission: z.enum(["allowed", "requires_authorization", "restricted"]),
  channels: z.array(channelSchema),
  knownRejectionPatterns: z.array(userFacingLine).default([]),
  excludedChannels: z.array(excludedChannelSchema).default([]),
  /** Maintainer research not tied to a single channel. */
  research: z.string().min(1).optional(),
});

export type RawCarrier = z.infer<typeof carrierSchema>;

export const directorySchema = z.array(carrierSchema).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.carrierIataCode)) {
      // The previous Map-keyed load silently kept whichever duplicate came
      // last, which would quietly change a carrier's channel with no signal.
      ctx.addIssue({ code: "custom", message: `duplicate carrierIataCode: ${entry.carrierIataCode}` });
    }
    seen.add(entry.carrierIataCode);
  }
});

export interface LoadedCarrier {
  readonly contact: AirlineClaimsContact;
  readonly research: CarrierResearch;
}

function toRequiredFields(raw: RawCarrier["channels"][number]["requiredFields"]): RequiredFields {
  return raw === null ? { known: false } : { known: true, fields: normaliseRequiredFields(raw) };
}

/**
 * THE boundary. One function, one file: everything that goes left is the public
 * contact, everything that goes right is maintainer research. There is no third
 * destination, and AirlineClaimsContact has no field the right-hand side could
 * be assigned to even by mistake.
 */
export function toLoadedCarrier(raw: RawCarrier): LoadedCarrier {
  const channels: ClaimChannel[] = [];
  const channelResearch: ChannelResearch[] = [];

  raw.channels.forEach((channel, index) => {
    const id = `${raw.carrierIataCode}#${index}`;
    const common = {
      id,
      lastCheckedOn: channel.verification.date,
      requiredFields: toRequiredFields(channel.requiredFields),
      guidance: channel.guidance,
    };

    const candidateUrls: string[] = [];
    const unverified = channel.verification.status === "unverified";
    // Narrowed for the confirmed branches below; the union's confirmed variants
    // are the only ones that carry an address at all.
    const confirmed = channel.verification.status as ConfirmedVerification;

    if (channel.kind === "web_form") {
      // entryUrl wins when both exist: it is the address a human can actually
      // navigate to. The one not chosen becomes research rather than a second
      // public URL — exposing two is exposing a choice, and the only thing
      // downstream that would make that choice is the model.
      const resolvedTemplate =
        channel.urlTemplate && channel.urlTemplateValues
          ? resolveTemplatedUrl(channel.urlTemplate, channel.urlTemplateValues)
          : undefined;
      const chosen = channel.entryUrl ?? channel.url ?? resolvedTemplate;

      for (const candidate of [channel.entryUrl, channel.url, resolvedTemplate]) {
        if (candidate && candidate !== (unverified ? undefined : chosen)) {
          candidateUrls.push(candidate);
        }
      }

      channels.push(
        unverified || chosen === undefined
          ? { ...common, kind: "web_form", verification: "unverified" }
          : { ...common, kind: "web_form", verification: confirmed, url: chosen },
      );
    } else if (channel.kind === "email") {
      channels.push(
        unverified || channel.address === undefined
          ? { ...common, kind: "email", verification: "unverified" }
          : { ...common, kind: "email", verification: confirmed, address: channel.address, mailbox: channel.mailbox },
      );
    } else {
      channels.push(
        unverified || channel.address === undefined
          ? { ...common, kind: "postal", verification: "unverified" }
          : { ...common, kind: "postal", verification: confirmed, address: channel.address },
      );
    }

    channelResearch.push({
      channelId: id,
      verificationMethod: channel.verification.method,
      verificationStatus: channel.verification.status,
      candidateUrls,
      ...(channel.verification.note !== undefined ? { verificationNote: channel.verification.note } : {}),
      ...(channel.research !== undefined ? { notes: channel.research } : {}),
    });
  });

  return {
    contact: {
      carrierIataCode: raw.carrierIataCode,
      carrierName: raw.carrierName,
      isEuCarrier: raw.isEuCarrier,
      thirdPartySubmission: raw.thirdPartySubmission,
      channels,
      knownRejectionPatterns: raw.knownRejectionPatterns,
    },
    research: {
      carrierIataCode: raw.carrierIataCode,
      channels: channelResearch,
      excludedChannels: raw.excludedChannels,
      ...(raw.research !== undefined ? { notes: raw.research } : {}),
    },
  };
}

import { ok, err, type Result } from "../../lib/result.js";
import type {
  AirlineClaimsContact,
  AirlineDirectoryError,
  AirlineDirectoryProvider,
  ClaimChannel,
  EmailChannel,
  PostalChannel,
  WebFormChannel,
} from "./airline-directory.port.js";
import type { ClaimFieldKey } from "../../domain/claim/claim-fields.js";

/**
 * In-memory adapter for tests and local dev.
 *
 * The real dataset (data/airlines.json) has no auto-sendable channel at all —
 * every carrier is a web form, and the one email address in it is ITA's PEC
 * legal mailbox, which is deliberately excluded from auto-send. Anything
 * exercising the actual send path therefore needs this instead. Seed it; it
 * never touches the real dataset or the network.
 */
export class FakeAirlineDirectoryAdapter implements AirlineDirectoryProvider {
  private readonly seeded = new Map<string, Result<AirlineClaimsContact, AirlineDirectoryError>>();

  seed(carrierIataCode: string, result: Result<AirlineClaimsContact, AirlineDirectoryError>): void {
    this.seeded.set(carrierIataCode.toUpperCase(), result);
  }

  async getAirline(carrierIataCode: string): Promise<Result<AirlineClaimsContact, AirlineDirectoryError>> {
    const code = carrierIataCode.toUpperCase();
    const seededResult = this.seeded.get(code);
    if (seededResult) {
      return seededResult;
    }
    return err({ type: "not_found", message: `No fixture seeded for carrier ${code}` });
  }

  async listAirlines(): Promise<AirlineClaimsContact[]> {
    return [...this.seeded.values()].filter((r): r is { ok: true; value: AirlineClaimsContact } => r.ok).map((r) => r.value);
  }
}

interface ChannelOverrides {
  id?: string;
  requiredFields?: readonly ClaimFieldKey[] | null;
  guidance?: readonly string[];
  verification?: "verified" | "partially_verified";
}

function common(defaultId: string, overrides: ChannelOverrides) {
  const requiredFields = overrides.requiredFields;
  return {
    id: overrides.id ?? defaultId,
    lastCheckedOn: "2026-08-11",
    guidance: overrides.guidance ?? [],
    requiredFields:
      requiredFields === null
        ? ({ known: false } as const)
        : ({ known: true, fields: requiredFields ?? [] } as const),
  };
}

export function buildWebFormChannel(
  overrides: ChannelOverrides & { url?: string } = {},
): Extract<WebFormChannel, { url: string }> {
  return {
    ...common("FAKE#web", overrides),
    kind: "web_form",
    verification: overrides.verification ?? "verified",
    url: overrides.url ?? "https://airline.example.test/claims",
  };
}

/** A web-form channel nobody has confirmed — no url property exists on it at
 * all, which is the point of the unverified variant. */
export function buildUnverifiedWebFormChannel(overrides: ChannelOverrides = {}): WebFormChannel {
  return { ...common("FAKE#unverified", overrides), kind: "web_form", verification: "unverified" };
}

export function buildEmailChannel(
  overrides: ChannelOverrides & { address?: string; mailbox?: "standard" | "pec" } = {},
): Extract<EmailChannel, { address: string }> {
  return {
    ...common("FAKE#email", overrides),
    kind: "email",
    verification: overrides.verification ?? "verified",
    address: overrides.address ?? "claims@lufthansa.example.test",
    mailbox: overrides.mailbox ?? "standard",
  };
}

export function buildPostalChannel(
  overrides: ChannelOverrides & { lines?: readonly string[]; countryIsoCode?: string } = {},
): Extract<PostalChannel, { address: unknown }> {
  return {
    ...common("FAKE#postal", overrides),
    kind: "postal",
    verification: overrides.verification ?? "verified",
    address: {
      lines: overrides.lines ?? ["Airline Customer Relations", "PO Box 1", "Example City"],
      countryIsoCode: overrides.countryIsoCode ?? "GB",
    },
  };
}

export function buildAirlineClaimsContact(overrides: Partial<AirlineClaimsContact> = {}): AirlineClaimsContact {
  const channels: ClaimChannel[] = [buildEmailChannel()];
  return {
    carrierIataCode: "LH",
    carrierName: "Lufthansa",
    isEuCarrier: true,
    thirdPartySubmission: "allowed",
    channels,
    knownRejectionPatterns: [],
    ...overrides,
  };
}

/** Convenience for the common case: any carrier code, always resolving to a
 * working auto-sendable email channel — avoids re-seeding per-code in tests
 * that don't care which carrier it is, just that sending works. */
export function buildAnyCodeEmailAirlineDirectory(): AirlineDirectoryProvider {
  return {
    async getAirline(carrierIataCode: string) {
      return ok(buildAirlineClaimsContact({ carrierIataCode: carrierIataCode.toUpperCase() }));
    },
    async listAirlines() {
      return [buildAirlineClaimsContact()];
    },
  };
}

/** Any carrier code, always resolving to a single confirmed web-form channel —
 * the "has to be submitted by hand" path. */
export function buildAnyCodeWebFormAirlineDirectory(
  requiredFields: readonly ClaimFieldKey[] | null = ["claimantFullName", "payoutIban"],
): AirlineDirectoryProvider {
  const contact = (code: string) =>
    buildAirlineClaimsContact({
      carrierIataCode: code.toUpperCase(),
      carrierName: "Ryanair",
      channels: [buildWebFormChannel({ requiredFields })],
    });
  return {
    async getAirline(carrierIataCode: string) {
      return ok(contact(carrierIataCode));
    },
    async listAirlines() {
      return [contact("FR")];
    },
  };
}

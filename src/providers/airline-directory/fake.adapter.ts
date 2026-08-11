import { ok, err, type Result } from "../../lib/result.js";
import type { AirlineDirectoryProvider, AirlineClaimsContact, AirlineDirectoryError } from "./airline-directory.port.js";

/**
 * In-memory adapter for tests/local dev needing a WORKING (email) submission
 * method. StaticAirlineDirectoryAdapter's real data is deliberately all
 * "unsupported" (see data/airlines.json — nothing has a sourced/verified
 * channel yet), so anything exercising the actual send path needs this
 * instead. Seed it, never touches the real dataset.
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

export function buildAirlineClaimsContact(overrides: Partial<AirlineClaimsContact> = {}): AirlineClaimsContact {
  return {
    carrierIataCode: "LH",
    carrierName: "Lufthansa",
    isEuCarrier: true,
    submissionMethod: { type: "email", claimsEmail: "claims@lufthansa.example.test", requiredFields: [] },
    knownRejectionPatterns: [],
    ...overrides,
  };
}

/** Convenience for the common case: any carrier code, always resolving to a
 * working email submission method — avoids re-seeding per-code in tests that
 * don't care which carrier it is, just that sending works. */
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

import { ok, err, type Result } from "../../lib/result.js";
import type { AirportReferenceProvider, AirportFacts, AirportReferenceError } from "./airport-reference.port.js";

/** In-memory adapter for tests and local dev. Seed it, never hits the network or a database. */
export class FakeAirportReferenceAdapter implements AirportReferenceProvider {
  private readonly seeded = new Map<string, Result<AirportFacts, AirportReferenceError>>();

  seed(iataCode: string, result: Result<AirportFacts, AirportReferenceError>): void {
    this.seeded.set(iataCode.toUpperCase(), result);
  }

  async getAirport(iataCode: string): Promise<Result<AirportFacts, AirportReferenceError>> {
    const code = iataCode.toUpperCase();
    const seededResult = this.seeded.get(code);
    if (seededResult) {
      return seededResult;
    }
    return err({ type: "not_found", message: `No fixture seeded for airport ${code}` });
  }
}

export function buildAirportFacts(overrides: Partial<AirportFacts> = {}): AirportFacts {
  return {
    iataCode: "LHR",
    icaoCode: "EGLL",
    name: "London Heathrow",
    countryIsoCode: "GB",
    latitude: 51.47,
    longitude: -0.4543,
    ...overrides,
  };
}

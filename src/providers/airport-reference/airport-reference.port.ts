import type { Result } from "../../lib/result.js";

export interface AirportFacts {
  iataCode: string;
  icaoCode: string;
  name: string;
  /** ISO-3166-1 alpha-2 country code, e.g. "IT" — a geographic fact, not a
   * legal one. Whether that country counts as "EU" for EC261 purposes is
   * src/domain/ec261/eu-membership.ts's call, not this provider's. */
  countryIsoCode: string;
  latitude: number;
  longitude: number;
}

export type AirportReferenceError =
  | { type: "not_found"; message: string }
  | { type: "rate_limited"; message: string }
  | { type: "upstream_error"; message: string };

export interface AirportReferenceProvider {
  getAirport(iataCode: string): Promise<Result<AirportFacts, AirportReferenceError>>;
}

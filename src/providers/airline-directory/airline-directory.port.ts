import type { Result } from "../../lib/result.js";

export interface AirlineClaimsContact {
  carrierIataCode: string;
  carrierName: string;
  /** True if the OPERATING carrier is an EU airline for EC261 route-coverage purposes. */
  isEuCarrier: boolean;
  claimsEmail: string;
  /** Short descriptive tags for boilerplate rejection patterns seen from this carrier. */
  knownRejectionPatterns: string[];
}

export type AirlineDirectoryError = { type: "not_found"; message: string };

export interface AirlineDirectoryProvider {
  getAirline(carrierIataCode: string): Promise<Result<AirlineClaimsContact, AirlineDirectoryError>>;
}

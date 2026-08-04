import type { Result } from "../../lib/result.js";

export interface FlightStatusQuery {
  /** IATA flight number, e.g. "BA123". */
  flightNumber: string;
  /** "YYYY-MM-DD" — disambiguates a flight number that operates daily. */
  scheduledDepartureDateUtc: string;
}

export type FlightDisruptionStatus = "on_time" | "delayed" | "cancelled" | "diverted" | "unknown";

export interface FlightStatusResult {
  flightNumber: string;
  operatingCarrierIataCode: string;
  departureAirportIata: string;
  arrivalAirportIata: string;
  scheduledDepartureUtc: string;
  actualDepartureUtc: string | null;
  scheduledArrivalUtc: string;
  actualArrivalUtc: string | null;
  status: FlightDisruptionStatus;
  /** Null unless status is "delayed" — computed on ARRIVAL, matching domain/ec261 usage. */
  delayMinutesAtArrival: number | null;
  /** Null unless status is "cancelled" and the cancellation date is known. */
  cancellationNoticeDays: number | null;
}

export type FlightStatusError =
  | { type: "not_found"; message: string }
  | { type: "auth_error"; message: string }
  | { type: "rate_limited"; message: string }
  | { type: "upstream_error"; message: string };

export interface FlightStatusProvider {
  getFlightStatus(query: FlightStatusQuery): Promise<Result<FlightStatusResult, FlightStatusError>>;
}

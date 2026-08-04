import type { Result } from "../../lib/result.js";

export interface WeatherQuery {
  /** 4-letter ICAO station code, e.g. "EGLL" — NOT the 3-letter IATA airport code. */
  icaoCode: string;
  /** UTC timestamp to find the nearest observation to. */
  atUtc: string;
}

export interface WeatherObservation {
  icaoCode: string;
  observedAtUtc: string;
  visibilityMeters: number | null;
  /** Height of the lowest broken/overcast cloud layer, in feet. Null if no ceiling. */
  ceilingFeet: number | null;
  windSpeedKnots: number | null;
  windGustKnots: number | null;
  thunderstorm: boolean;
  rawMetar: string;
}

export type WeatherError =
  | { type: "not_found"; message: string }
  | { type: "rate_limited"; message: string }
  | { type: "upstream_error"; message: string };

export interface WeatherProvider {
  getObservation(query: WeatherQuery): Promise<Result<WeatherObservation, WeatherError>>;
}

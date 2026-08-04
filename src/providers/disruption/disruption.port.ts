import type { Result } from "../../lib/result.js";

export interface DisruptionQuery {
  airportIata: string;
  /** "YYYY-MM-DD" */
  dateUtc: string;
}

export type DisruptionCauseCode = "atc_strike" | "third_party_staff_strike" | "notam_closure" | "other";

export interface DisruptionEvent {
  airportIata: string;
  dateUtc: string;
  causeCode: DisruptionCauseCode;
  description: string;
  source: string;
}

export type DisruptionError =
  | { type: "rate_limited"; message: string }
  | { type: "upstream_error"; message: string };

export interface DisruptionProvider {
  /** Empty array (not an error) means "checked, nothing found" — a real, useful result. */
  getDisruptions(query: DisruptionQuery): Promise<Result<DisruptionEvent[], DisruptionError>>;
}

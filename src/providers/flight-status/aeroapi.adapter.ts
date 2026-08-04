import { ok, err, type Result } from "../../lib/result.js";
import type {
  FlightStatusProvider,
  FlightStatusQuery,
  FlightStatusResult,
  FlightStatusError,
  FlightDisruptionStatus,
} from "./flight-status.port.js";

/**
 * Real adapter against FlightAware's AeroAPI v4.
 *
 * UNVERIFIED against a live response — unlike the weather adapter (checked against
 * the real IEM endpoint before being written), AeroAPI requires a paid/signup API
 * key we don't have yet. The mapping below reflects AeroAPI v4's documented schema
 * as best understood; treat it as a first draft and re-verify every field against
 * a real response the moment a FLIGHT_DATA_API_KEY is available — a silently wrong
 * field mapping here produces a wrong eligibility/compensation decision.
 *
 * "Arrival" is deliberately the gate time (scheduled_in/actual_in), not runway
 * touchdown (scheduled_on/actual_on): CJEU C-452/13 (Germanwings v Henning) holds
 * that "arrival time" for EC261 purposes is when a door of the aircraft is opened,
 * i.e. gate arrival, not wheels-on.
 */
const BASE_URL = "https://aeroapi.flightaware.com/aeroapi";

interface AeroApiAirportRef {
  code_iata: string | null;
}

interface AeroApiFlight {
  ident_iata: string | null;
  operator_iata: string | null;
  origin: AeroApiAirportRef | null;
  destination: AeroApiAirportRef | null;
  scheduled_out: string | null;
  actual_out: string | null;
  scheduled_in: string | null;
  actual_in: string | null;
  cancelled: boolean;
  diverted: boolean;
}

interface AeroApiFlightsResponse {
  flights: AeroApiFlight[];
}

function computeArrivalStatus(flight: AeroApiFlight): {
  status: FlightDisruptionStatus;
  delayMinutesAtArrival: number | null;
} {
  if (flight.cancelled) {
    return { status: "cancelled", delayMinutesAtArrival: null };
  }
  if (flight.diverted) {
    return { status: "diverted", delayMinutesAtArrival: null };
  }
  if (!flight.actual_in || !flight.scheduled_in) {
    return { status: "unknown", delayMinutesAtArrival: null };
  }

  const delayMs = new Date(flight.actual_in).getTime() - new Date(flight.scheduled_in).getTime();
  const delayMinutes = Math.max(0, Math.round(delayMs / 60_000));
  return { status: delayMinutes > 0 ? "delayed" : "on_time", delayMinutesAtArrival: delayMinutes };
}

function toFlightStatusResult(flightNumber: string, flight: AeroApiFlight): FlightStatusResult | null {
  if (!flight.origin?.code_iata || !flight.destination?.code_iata || !flight.scheduled_out || !flight.scheduled_in) {
    return null;
  }

  const { status, delayMinutesAtArrival } = computeArrivalStatus(flight);

  return {
    flightNumber,
    operatingCarrierIataCode: flight.operator_iata ?? flightNumber.slice(0, 2).toUpperCase(),
    departureAirportIata: flight.origin.code_iata,
    arrivalAirportIata: flight.destination.code_iata,
    scheduledDepartureUtc: flight.scheduled_out,
    actualDepartureUtc: flight.actual_out,
    scheduledArrivalUtc: flight.scheduled_in,
    actualArrivalUtc: flight.actual_in,
    status,
    delayMinutesAtArrival,
    // AeroAPI doesn't report when the airline notified passengers of a
    // cancellation — that has to come from the booking/email side, not here.
    cancellationNoticeDays: null,
  };
}

export class AeroApiFlightStatusAdapter implements FlightStatusProvider {
  constructor(private readonly apiKey: string) {}

  async getFlightStatus(
    query: FlightStatusQuery,
  ): Promise<Result<FlightStatusResult, FlightStatusError>> {
    const url = new URL(`${BASE_URL}/flights/${encodeURIComponent(query.flightNumber)}`);
    url.searchParams.set("start", query.scheduledDepartureDateUtc);
    url.searchParams.set("end", query.scheduledDepartureDateUtc);

    let response: Response;
    try {
      response = await fetch(url, { headers: { "x-apikey": this.apiKey } });
    } catch (cause) {
      return err({ type: "upstream_error", message: `Network error calling AeroAPI: ${String(cause)}` });
    }

    if (response.status === 401 || response.status === 403) {
      return err({ type: "auth_error", message: "AeroAPI rejected the API key" });
    }
    if (response.status === 404) {
      return err({ type: "not_found", message: `No AeroAPI flight found for ${query.flightNumber}` });
    }
    if (response.status === 429) {
      return err({ type: "rate_limited", message: "AeroAPI rate-limited the request" });
    }
    if (!response.ok) {
      return err({ type: "upstream_error", message: `AeroAPI returned HTTP ${response.status}` });
    }

    let body: AeroApiFlightsResponse;
    try {
      body = (await response.json()) as AeroApiFlightsResponse;
    } catch (cause) {
      return err({ type: "upstream_error", message: `Malformed AeroAPI response: ${String(cause)}` });
    }

    const flight = body.flights?.[0];
    if (!flight) {
      return err({
        type: "not_found",
        message: `No AeroAPI flight found for ${query.flightNumber} on ${query.scheduledDepartureDateUtc}`,
      });
    }

    const result = toFlightStatusResult(query.flightNumber, flight);
    if (!result) {
      return err({
        type: "upstream_error",
        message: `AeroAPI response for ${query.flightNumber} was missing required fields`,
      });
    }

    return ok(result);
  }
}

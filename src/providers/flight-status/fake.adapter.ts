import { err, type Result } from "../../lib/result.js";
import type {
  FlightStatusProvider,
  FlightStatusQuery,
  FlightStatusResult,
  FlightStatusError,
} from "./flight-status.port.js";

function key(query: FlightStatusQuery): string {
  return `${query.flightNumber.toUpperCase()}_${query.scheduledDepartureDateUtc}`;
}

/** In-memory adapter for tests and local dev. Seed it, never hits the network. */
export class FakeFlightStatusAdapter implements FlightStatusProvider {
  private readonly seeded = new Map<string, Result<FlightStatusResult, FlightStatusError>>();

  seed(query: FlightStatusQuery, result: Result<FlightStatusResult, FlightStatusError>): void {
    this.seeded.set(key(query), result);
  }

  async getFlightStatus(
    query: FlightStatusQuery,
  ): Promise<Result<FlightStatusResult, FlightStatusError>> {
    const seededResult = this.seeded.get(key(query));
    if (seededResult) {
      return seededResult;
    }
    return err({
      type: "not_found",
      message: `No fixture seeded for flight ${query.flightNumber} on ${query.scheduledDepartureDateUtc}`,
    });
  }
}

export function buildOnTimeResult(overrides: Partial<FlightStatusResult> = {}): FlightStatusResult {
  return {
    flightNumber: "BA123",
    operatingCarrierIataCode: "BA",
    departureAirportIata: "LHR",
    arrivalAirportIata: "JFK",
    scheduledDepartureUtc: "2024-06-15T10:00:00.000Z",
    actualDepartureUtc: "2024-06-15T10:00:00.000Z",
    scheduledArrivalUtc: "2024-06-15T18:00:00.000Z",
    actualArrivalUtc: "2024-06-15T18:00:00.000Z",
    status: "on_time",
    delayMinutesAtArrival: null,
    cancellationNoticeDays: null,
    ...overrides,
  };
}

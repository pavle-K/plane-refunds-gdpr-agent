import type { Booking } from "../domain/claim/claim.types.js";
import type { KnownClaimFacts } from "../domain/claim/prefill.js";
import type { FlightStatusResult } from "../providers/flight-status/flight-status.port.js";

/**
 * Maps what the pipeline holds onto the canonical claim-field vocabulary the
 * prefill resolver speaks.
 *
 * Lives here rather than in domain/ because it reads FlightStatusResult, a
 * provider type — domain stays free of provider imports. It exists at all
 * because this mapping had been written twice, and the second copy quietly
 * omitted the itinerary: the printed claim form showed the flight at the top of
 * the page AND listed "flight number(s), date and route" as still needed. One
 * definition, used by both the drafting node and the postal-pack tool.
 */
export function toKnownClaimFacts(params: {
  booking: Booking;
  flightStatuses: FlightStatusResult[];
  compensationCents: number;
}): KnownClaimFacts {
  const { booking, flightStatuses, compensationCents } = params;

  const names = booking.passengers.map((p) => p.fullName).filter((n): n is string => Boolean(n?.trim()));

  return {
    bookingReference: booking.bookingReference,
    flightItinerary: formatItineraryLines(flightStatuses).join("; "),
    disruptionType: flightStatuses.some((s) => s.status === "cancelled") ? "cancellation" : "delay",
    ...(names.length > 0 ? { passengerNames: names.join(", ") } : {}),
    compensationAmount: formatEuros(compensationCents),
  };
}

/** One line per segment, in itinerary order. */
export function formatItineraryLines(flightStatuses: FlightStatusResult[]): string[] {
  return flightStatuses.map(
    (s) => `${s.flightNumber}: ${s.departureAirportIata} -> ${s.arrivalAirportIata}, ${s.scheduledDepartureUtc.slice(0, 10)}`,
  );
}

/** EC261 bands are always whole euros — see domain/ec261/compensation.ts. */
export function formatEuros(cents: number): string {
  return `€${Math.round(cents / 100)}`;
}

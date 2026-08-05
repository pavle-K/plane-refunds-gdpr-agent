import type { GraphStateType } from "../state.js";
import type { FlightStatusProvider } from "../../providers/flight-status/flight-status.port.js";
import type { FlightStatusResult } from "../../providers/flight-status/flight-status.port.js";
import type { AirlineDirectoryProvider } from "../../providers/airline-directory/airline-directory.port.js";
import { checkEligibility, type DisruptionType } from "../../domain/ec261/eligibility.js";
import { getDistanceKm } from "../../domain/ec261/distance.js";
import { getCompensationCents } from "../../domain/ec261/compensation.js";
import { getAirportReference } from "../../domain/ec261/airport-reference.js";

export interface CheckEligibilityNodeDeps {
  flightStatus: FlightStatusProvider;
  airlineDirectory: AirlineDirectoryProvider;
}

/**
 * Denied-boarding claims aren't detectable from flight-status data (overbooking is
 * a booking-level event, not a schedule event) — out of scope for this node until
 * there's a signal source for it. Only delay/cancellation are handled here.
 *
 * Connecting itineraries (booking.segments.length > 1) are judged as ONE trip per
 * Folkerts v Air France (C-11/11): eligibility is based on the FINAL segment's
 * arrival delay, never an intermediate leg, and route coverage is based on the
 * FIRST segment's departure and the LAST segment's arrival/carrier. Compensation
 * distance is direct first-departure-to-final-arrival (Art. 7(4)), not the sum of
 * leg distances. Segments are treated as fixed/as-booked — a missed connection
 * that gets the passenger rebooked onto a DIFFERENT flight number than originally
 * booked isn't modeled here; that's a real gap, not a silent approximation.
 */
export function createCheckEligibilityNode(deps: CheckEligibilityNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (!state.booking) {
      throw new Error("checkEligibility: booking is required");
    }
    if (state.booking.segments.length === 0) {
      throw new Error("checkEligibility: booking must have at least one segment");
    }

    const statusResults = await Promise.all(
      state.booking.segments.map((segment) =>
        deps.flightStatus.getFlightStatus({
          flightNumber: segment.flightNumber,
          scheduledDepartureDateUtc: segment.scheduledDepartureUtc.slice(0, 10),
        }),
      ),
    );

    for (const [index, result] of statusResults.entries()) {
      if (!result.ok) {
        return {
          eligible: false,
          eligibilityReason: `Flight status lookup failed for segment ${index + 1} (${result.error.type}): ${result.error.message}`,
        };
      }
    }

    const flightStatuses = statusResults.map((r) => {
      if (!r.ok) {
        throw new Error("unreachable: failures already handled above");
      }
      return r.value;
    });

    const firstSegment = flightStatuses[0] as FlightStatusResult;
    const lastSegment = flightStatuses[flightStatuses.length - 1] as FlightStatusResult;

    const cancelledSegment = flightStatuses.find((s) => s.status === "cancelled");

    let disruptionType: DisruptionType;
    let delayMinutesAtArrival: number | undefined;
    let cancellationNoticeDays: number | undefined;

    if (cancelledSegment) {
      if (cancelledSegment.cancellationNoticeDays === null) {
        return {
          flightStatuses,
          eligible: false,
          eligibilityReason: "A segment was cancelled but the cancellation notice period is unknown — needs manual review.",
        };
      }
      disruptionType = "cancellation";
      cancellationNoticeDays = cancelledSegment.cancellationNoticeDays;
    } else if (lastSegment.status === "delayed") {
      disruptionType = "delay";
      delayMinutesAtArrival = lastSegment.delayMinutesAtArrival ?? 0;
    } else {
      return {
        flightStatuses,
        eligible: false,
        eligibilityReason: `Final segment status is "${lastSegment.status}" — no compensable disruption at the final destination.`,
      };
    }

    const airlineResult = await deps.airlineDirectory.getAirline(lastSegment.operatingCarrierIataCode);
    const operatingCarrierIsEU = airlineResult.ok ? airlineResult.value.isEuCarrier : false;

    let departureCountryIsEU = false;
    let arrivalCountryIsEU = false;
    try {
      departureCountryIsEU = getAirportReference(firstSegment.departureAirportIata).countryIsEu;
      arrivalCountryIsEU = getAirportReference(lastSegment.arrivalAirportIata).countryIsEu;
    } catch {
      // Unknown airport reference — falls through as non-EU, which is the
      // conservative (claim-denying) direction rather than a false positive.
    }

    const eligibility = checkEligibility({
      disruptionType,
      ...(delayMinutesAtArrival !== undefined ? { delayMinutesAtArrival } : {}),
      ...(cancellationNoticeDays !== undefined ? { cancellationNoticeDays } : {}),
      departureCountryIsEU,
      arrivalCountryIsEU,
      operatingCarrierIsEU,
    });

    let compensationCents: number | null = null;
    try {
      // Direct distance from the ORIGINAL departure to the FINAL destination,
      // ignoring any stops — per Art. 7(4), not the sum of the leg distances.
      const distanceKm = getDistanceKm(firstSegment.departureAirportIata, lastSegment.arrivalAirportIata);
      compensationCents = getCompensationCents(distanceKm);
    } catch {
      // Unknown airport in the distance table — compensation stays null; a human
      // needs to resolve the amount manually rather than the graph guessing.
    }

    return {
      flightStatuses,
      eligible: eligibility.eligible,
      eligibilityReason: eligibility.reason,
      compensationCents,
    };
  };
}

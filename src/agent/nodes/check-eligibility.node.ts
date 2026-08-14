import type { GraphStateType } from "../state.js";
import type { FlightStatusProvider } from "../../providers/flight-status/flight-status.port.js";
import type { FlightStatusResult } from "../../providers/flight-status/flight-status.port.js";
import type { AirlineDirectoryProvider } from "../../providers/airline-directory/airline-directory.port.js";
import type { AirportReferenceProvider } from "../../providers/airport-reference/airport-reference.port.js";
import { checkEligibility, type DisruptionType } from "../../domain/ec261/eligibility.js";
import { getDistanceKm } from "../../domain/ec261/distance.js";
import { getCompensationCents } from "../../domain/ec261/compensation.js";
import { isEuMemberCountry } from "../../domain/ec261/eu-membership.js";

export interface CheckEligibilityNodeDeps {
  flightStatus: FlightStatusProvider;
  airlineDirectory: AirlineDirectoryProvider;
  airportReference: AirportReferenceProvider;
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

    const [airlineResult, departureAirportResult, arrivalAirportResult] = await Promise.all([
      deps.airlineDirectory.getAirline(lastSegment.operatingCarrierIataCode),
      deps.airportReference.getAirport(firstSegment.departureAirportIata),
      deps.airportReference.getAirport(lastSegment.arrivalAirportIata),
    ]);
    const operatingCarrierIsEU = airlineResult.ok ? airlineResult.value.isEuCarrier : false;

    // A failed lookup on EITHER side falls through as non-EU for just that
    // side, not both — the conservative (claim-denying) direction, not a
    // false positive.
    const departureCountryIsEU = departureAirportResult.ok && isEuMemberCountry(departureAirportResult.value.countryIsoCode);
    const arrivalCountryIsEU = arrivalAirportResult.ok && isEuMemberCountry(arrivalAirportResult.value.countryIsoCode);

    const eligibility = checkEligibility({
      disruptionType,
      ...(delayMinutesAtArrival !== undefined ? { delayMinutesAtArrival } : {}),
      ...(cancellationNoticeDays !== undefined ? { cancellationNoticeDays } : {}),
      departureCountryIsEU,
      arrivalCountryIsEU,
      operatingCarrierIsEU,
    });

    // Direct distance from the ORIGINAL departure to the FINAL destination,
    // ignoring any stops — per Art. 7(4), not the sum of the leg distances.
    // Compensation stays null if either airport's coordinates couldn't be
    // resolved — a human needs to resolve the amount manually rather than the
    // graph guessing.
    const compensationCents =
      departureAirportResult.ok && arrivalAirportResult.ok
        ? getCompensationCents(
            getDistanceKm(
              { lat: departureAirportResult.value.latitude, lon: departureAirportResult.value.longitude },
              { lat: arrivalAirportResult.value.latitude, lon: arrivalAirportResult.value.longitude },
            ),
          )
        : null;

    // "Eligible, amount unknown" cannot continue: draftClaim requires a
    // compensationCents and used to throw an opaque error several nodes later
    // when it got null here. That's reachable — an unresolvable DEPARTURE
    // airport leaves compensationCents null while eligibility can still come
    // out true on arrival-side coverage (EU arrival + EU carrier). Short-circuit
    // with the reason named, matching how this node already handles an unknown
    // cancellation notice period: an unresolvable input surfaces as a stated
    // manual-review reason, never as a crash and never as a guessed amount.
    if (eligibility.eligible && compensationCents === null) {
      const unresolved = [
        ...(departureAirportResult.ok ? [] : [firstSegment.departureAirportIata]),
        ...(arrivalAirportResult.ok ? [] : [lastSegment.arrivalAirportIata]),
      ].join(", ");
      return {
        flightStatuses,
        eligible: false,
        eligibilityReason:
          `This flight appears to qualify (${eligibility.reason}), but the compensation amount can't be ` +
          `computed: no airport reference data for ${unresolved}, so the route distance is unknown. ` +
          "Needs manual review — the amount must not be guessed.",
        compensationCents: null,
      };
    }

    return {
      flightStatuses,
      eligible: eligibility.eligible,
      eligibilityReason: eligibility.reason,
      compensationCents,
    };
  };
}

import type { GraphStateType } from "../state.js";
import type { FlightStatusProvider } from "../../providers/flight-status/flight-status.port.js";
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
 */
export function createCheckEligibilityNode(deps: CheckEligibilityNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (!state.booking) {
      throw new Error("checkEligibility: booking is required");
    }

    const statusResult = await deps.flightStatus.getFlightStatus({
      flightNumber: state.booking.flightNumber,
      scheduledDepartureDateUtc: state.booking.scheduledDepartureUtc.slice(0, 10),
    });

    if (!statusResult.ok) {
      return {
        eligible: false,
        eligibilityReason: `Flight status lookup failed (${statusResult.error.type}): ${statusResult.error.message}`,
      };
    }

    const flightStatus = statusResult.value;

    let disruptionType: DisruptionType;
    let delayMinutesAtArrival: number | undefined;
    let cancellationNoticeDays: number | undefined;

    if (flightStatus.status === "cancelled") {
      if (flightStatus.cancellationNoticeDays === null) {
        return {
          flightStatus,
          eligible: false,
          eligibilityReason: "Flight was cancelled but the cancellation notice period is unknown — needs manual review.",
        };
      }
      disruptionType = "cancellation";
      cancellationNoticeDays = flightStatus.cancellationNoticeDays;
    } else if (flightStatus.status === "delayed") {
      disruptionType = "delay";
      delayMinutesAtArrival = flightStatus.delayMinutesAtArrival ?? 0;
    } else {
      return {
        flightStatus,
        eligible: false,
        eligibilityReason: `Flight status is "${flightStatus.status}" — no compensable disruption.`,
      };
    }

    const airlineResult = await deps.airlineDirectory.getAirline(flightStatus.operatingCarrierIataCode);
    const operatingCarrierIsEU = airlineResult.ok ? airlineResult.value.isEuCarrier : false;

    let departureCountryIsEU = false;
    let arrivalCountryIsEU = false;
    try {
      departureCountryIsEU = getAirportReference(flightStatus.departureAirportIata).countryIsEu;
      arrivalCountryIsEU = getAirportReference(flightStatus.arrivalAirportIata).countryIsEu;
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
      const distanceKm = getDistanceKm(flightStatus.departureAirportIata, flightStatus.arrivalAirportIata);
      compensationCents = getCompensationCents(distanceKm);
    } catch {
      // Unknown airport in the distance table — compensation stays null; a human
      // needs to resolve the amount manually rather than the graph guessing.
    }

    return {
      flightStatus,
      eligible: eligibility.eligible,
      eligibilityReason: eligibility.reason,
      compensationCents,
    };
  };
}

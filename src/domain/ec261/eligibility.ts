import {
  EC261_DELAY_THRESHOLD_MINUTES,
  EC261_CANCELLATION_NOTICE_THRESHOLD_DAYS,
} from "../../config/constants.js";

export type DisruptionType = "delay" | "cancellation" | "denied_boarding";

/**
 * All fields here are ITINERARY-WIDE, not per-segment — this matters as soon as
 * a booking has a connection. Per Folkerts v Air France (C-11/11), a connecting
 * itinerary is judged as a single trip: delay is measured at the FINAL
 * destination's arrival, never an intermediate leg. A delay on an early segment
 * that's absorbed before the final arrival is NOT compensable; a delay on any
 * segment that causes the final arrival to be 3+ hours late makes the WHOLE
 * itinerary eligible — there is no such thing as "a claim for just one leg."
 * Combining multiple segments into these fields is the caller's job (see
 * check-eligibility.node.ts); this function only ever sees the combined result.
 */
export interface EligibilityInput {
  disruptionType: DisruptionType;
  /** Required when disruptionType is "delay". The delay at the FINAL destination
   * of the whole itinerary — never an intermediate segment, never departure. */
  delayMinutesAtArrival?: number;
  /** Required when disruptionType is "cancellation". */
  cancellationNoticeDays?: number;
  /** Whether the FIRST segment's departure airport is in the EU. */
  departureCountryIsEU: boolean;
  /** Whether the LAST segment's arrival airport is in the EU. */
  arrivalCountryIsEU: boolean;
  /**
   * Nationality of the operating carrier of the LAST segment (the one actually
   * arriving in the EU) — the most defensible reading of Article 3(1)(b) for a
   * connecting itinerary, but flagged as a genuine area of legal nuance: which
   * carrier's nationality controls when different carriers operate different
   * legs isn't settled beyond doubt. Verify with counsel for interline cases.
   */
  operatingCarrierIsEU: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
}

export class InvalidEligibilityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEligibilityInputError";
  }
}

/**
 * EC261 covers: any flight departing an EU airport (any carrier), or any flight
 * arriving at an EU airport operated by an EU carrier. Arrival-into-EU on a
 * non-EU carrier is NOT covered.
 */
function isRouteCovered(input: EligibilityInput): boolean {
  return input.departureCountryIsEU || (input.arrivalCountryIsEU && input.operatingCarrierIsEU);
}

export function checkEligibility(input: EligibilityInput): EligibilityResult {
  if (!isRouteCovered(input)) {
    return {
      eligible: false,
      reason:
        "Route not covered by EC261: departure is outside the EU, and the arrival is either outside the EU or operated by a non-EU carrier.",
    };
  }

  switch (input.disruptionType) {
    case "denied_boarding":
      return {
        eligible: true,
        reason: "Denied boarding due to overbooking is eligible on any covered route.",
      };

    case "cancellation": {
      if (input.cancellationNoticeDays === undefined) {
        throw new InvalidEligibilityInputError(
          "cancellationNoticeDays is required when disruptionType is 'cancellation'",
        );
      }
      if (input.cancellationNoticeDays >= EC261_CANCELLATION_NOTICE_THRESHOLD_DAYS) {
        return {
          eligible: false,
          reason: `Cancellation notice of ${input.cancellationNoticeDays} day(s) meets the ${EC261_CANCELLATION_NOTICE_THRESHOLD_DAYS}-day threshold.`,
        };
      }
      return {
        eligible: true,
        reason: `Cancellation notice of ${input.cancellationNoticeDays} day(s) is under the ${EC261_CANCELLATION_NOTICE_THRESHOLD_DAYS}-day threshold.`,
      };
    }

    case "delay": {
      if (input.delayMinutesAtArrival === undefined) {
        throw new InvalidEligibilityInputError(
          "delayMinutesAtArrival is required when disruptionType is 'delay'",
        );
      }
      if (input.delayMinutesAtArrival >= EC261_DELAY_THRESHOLD_MINUTES) {
        return {
          eligible: true,
          reason: `Arrival delay of ${input.delayMinutesAtArrival} minute(s) meets the ${EC261_DELAY_THRESHOLD_MINUTES}-minute threshold.`,
        };
      }
      return {
        eligible: false,
        reason: `Arrival delay of ${input.delayMinutesAtArrival} minute(s) is under the ${EC261_DELAY_THRESHOLD_MINUTES}-minute threshold.`,
      };
    }

    default: {
      const exhaustiveCheck: never = input.disruptionType;
      throw new InvalidEligibilityInputError(`Unknown disruptionType: ${String(exhaustiveCheck)}`);
    }
  }
}

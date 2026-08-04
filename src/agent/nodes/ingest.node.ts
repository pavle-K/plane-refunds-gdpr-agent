import type { GraphStateType } from "../state.js";
import type { Booking } from "../../domain/claim/claim.types.js";
import { parseBookingEmail, type BookingExtractor } from "../../providers/email-ingest/booking-parser.js";

export interface IngestNodeDeps {
  extractor: BookingExtractor;
}

/**
 * Normalizes either an already-structured booking (uploaded confirmation) or a raw
 * inbox email into a Booking. Airport codes are deliberately left unset here —
 * they get enriched from the flight-status lookup in checkEligibility, since
 * booking-parser.ts doesn't extract them (see its Stage 1 fixtures/tests).
 */
export function createIngestNode(deps: IngestNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (state.booking) {
      return {};
    }
    if (!state.rawEmailText) {
      throw new Error("ingest: neither a booking nor rawEmailText was provided");
    }

    const parsed = await parseBookingEmail(
      {
        id: "inbound",
        from: "unknown",
        subject: "",
        receivedAtUtc: new Date().toISOString(),
        bodyText: state.rawEmailText,
      },
      deps.extractor,
    );

    if (!parsed) {
      throw new Error("ingest: could not extract a booking from the provided email");
    }

    const booking: Booking = {
      bookingReference: parsed.bookingReference,
      passengers: [{ id: "passenger-1", fullName: parsed.passengerFullName, email: "" }],
      flightNumber: parsed.flightNumber,
      operatingCarrierCode: parsed.flightNumber.slice(0, 2).toUpperCase(),
      scheduledDepartureUtc: `${parsed.scheduledDepartureDateUtc}T00:00:00.000Z`,
      scheduledArrivalUtc: `${parsed.scheduledDepartureDateUtc}T00:00:00.000Z`,
    };

    return { booking };
  };
}

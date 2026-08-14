export type ClaimStatus =
  | "draft"
  | "pending_approval"
  | "declined"
  | "sent"
  | "needs_manual_submission"
  | "awaiting_response"
  | "rejected"
  | "rebutting"
  | "escalated"
  | "accepted"
  | "paid";

/**
 * Both fields are nullable because they genuinely often aren't known yet. They
 * used to be required, which forced every construction site to invent something
 * — `email: ""` at all three of them, and `fullName: "Unknown Passenger"` in the
 * chat path — and those placeholders then rendered into user-facing claim
 * letters as if they were facts. An absent name is now absent, and the prefill
 * resolver reports it as something to ask for.
 */
export interface Passenger {
  id: string;
  fullName: string | null;
  email: string | null;
}

export interface FlightSegment {
  flightNumber: string;
  operatingCarrierCode: string;
  /** May be unknown at ingest time — enriched from a flight-status lookup. */
  departureAirportIata?: string;
  arrivalAirportIata?: string;
  scheduledDepartureUtc: string;
  scheduledArrivalUtc: string;
}

export interface Booking {
  bookingReference: string;
  passengers: Passenger[];
  /**
   * A single-flight trip is just a one-element array. For a connecting
   * itinerary, order matters: segments[0] is the first departure, the last
   * element is the final arrival — that's what EC261 eligibility keys off
   * (Folkerts v Air France, C-11/11: delay is judged at the FINAL
   * destination, never an intermediate leg — see domain/ec261/eligibility.ts).
   */
  segments: FlightSegment[];
}

export interface Claim {
  id: string;
  booking: Booking;
  status: ClaimStatus;
  createdAtUtc: string;
  compensationCents: number;
}

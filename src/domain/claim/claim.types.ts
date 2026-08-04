export type ClaimStatus =
  | "draft"
  | "pending_approval"
  | "declined"
  | "sent"
  | "awaiting_response"
  | "rejected"
  | "rebutting"
  | "escalated"
  | "accepted"
  | "paid";

export interface Passenger {
  id: string;
  fullName: string;
  email: string;
}

export interface Booking {
  bookingReference: string;
  passengers: Passenger[];
  flightNumber: string;
  operatingCarrierCode: string;
  departureAirportIata: string;
  arrivalAirportIata: string;
  scheduledDepartureUtc: string;
  scheduledArrivalUtc: string;
}

export interface Claim {
  id: string;
  booking: Booking;
  status: ClaimStatus;
  createdAtUtc: string;
  compensationCents: number;
}

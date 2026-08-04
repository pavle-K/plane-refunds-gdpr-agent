import type { EmailMessage } from "./email-ingest.port.js";

export interface ParsedBooking {
  bookingReference: string;
  flightNumber: string;
  scheduledDepartureDateUtc: string;
  passengerFullName: string;
}

/**
 * The real implementation of this (Stage 2) is an LLM call — kept as an injected
 * function so this module never depends on a real LLM, per CLAUDE.md's "no test
 * uses a real LLM call" rule. Tests inject a fake/deterministic extractor.
 */
export type BookingExtractor = (emailBodyText: string) => Promise<ParsedBooking | null>;

const BOOKING_KEYWORDS = [
  /booking reference/i,
  /buchungsnummer/i,
  /pnr/i,
  /confirmation number/i,
  /e-?ticket/i,
];

/**
 * Cheap pre-filter so obvious non-bookings (marketing emails, receipts for other
 * things) never reach the LLM extractor — saves the call, and gives a clean,
 * fully-testable rejection path with no LLM involved at all.
 */
export function looksLikeBookingEmail(bodyText: string): boolean {
  return BOOKING_KEYWORDS.some((pattern) => pattern.test(bodyText));
}

export async function parseBookingEmail(
  email: EmailMessage,
  extract: BookingExtractor,
): Promise<ParsedBooking | null> {
  if (!looksLikeBookingEmail(email.bodyText)) {
    return null;
  }
  return extract(email.bodyText);
}

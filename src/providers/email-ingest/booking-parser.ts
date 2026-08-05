import { err, type Result } from "../../lib/result.js";
import type { EmailMessage, EmailIngestError } from "./email-ingest.port.js";

export interface ParsedBookingSegment {
  flightNumber: string;
  scheduledDepartureDateUtc: string;
}

export interface ParsedBooking {
  bookingReference: string;
  passengerFullName: string;
  /** In itinerary order, first departure to final arrival — see Folkerts v Air France, C-11/11. */
  segments: ParsedBookingSegment[];
}

/** Fetches the extracted text of a named attachment on the email currently being parsed. */
export type AttachmentFetcher = (filename: string) => Promise<Result<string, EmailIngestError>>;

/** Used when no real attachment access is available (e.g. the single-email ingest path). */
export const noAttachmentFetcher: AttachmentFetcher = async (filename) =>
  err({ type: "not_found", message: `No attachment fetcher configured (requested "${filename}")` });

/**
 * The real implementation of this (Stage 2) is an LLM call — kept as an injected
 * function so this module never depends on a real LLM, per CLAUDE.md's "no test
 * uses a real LLM call" rule. Tests inject a fake/deterministic extractor.
 *
 * Receives the full email (including attachment metadata) plus a fetcher so the
 * real extractor can pull an attachment's text on demand — e.g. when the body
 * alone doesn't contain a flight number that turns out to be in a PDF ticket.
 */
export type BookingExtractor = (
  email: EmailMessage,
  fetchAttachment: AttachmentFetcher,
) => Promise<ParsedBooking | null>;

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
  fetchAttachment: AttachmentFetcher = noAttachmentFetcher,
): Promise<ParsedBooking | null> {
  if (!looksLikeBookingEmail(email.bodyText)) {
    return null;
  }
  return extract(email, fetchAttachment);
}

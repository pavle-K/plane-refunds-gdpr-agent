import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBookingEmail, looksLikeBookingEmail, type BookingExtractor, type ParsedBooking } from "../../../../src/providers/email-ingest/booking-parser.js";
import type { EmailMessage } from "../../../../src/providers/email-ingest/email-ingest.port.js";

interface EmailFixture {
  subject: string;
  bodyText: string;
}

function loadFixture(name: string): EmailFixture {
  const path = fileURLToPath(new URL(`../../../fixtures/emails/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as EmailFixture;
}

function buildEmail(fixture: EmailFixture): EmailMessage {
  return {
    id: "msg-1",
    from: "noreply@example.com",
    subject: fixture.subject,
    receivedAtUtc: "2024-06-01T00:00:00.000Z",
    bodyText: fixture.bodyText,
    attachments: [],
  };
}

/**
 * Stands in for the real (Stage 2/3) LLM extractor — a fake, deterministic
 * regex-based parser over clearly-labeled fixture fields, in both English and
 * German. No LLM call happens in this test, per CLAUDE.md's testing rules.
 * Ignores attachments/fetchAttachment — none of the fixtures need them.
 */
function createFixtureExtractor(): BookingExtractor {
  return async (email, _fetchAttachment): Promise<ParsedBooking | null> => {
    const text = email.bodyText;
    const refMatch = text.match(/(?:Booking reference|Buchungsnummer|PNR|Confirmation number)[:\s]+([A-Z0-9]{5,8})/i);
    const flightMatch = text.match(/(?:Flight|Flugnummer)[:\s]+([A-Z]{2}\d{2,4})/i);
    const dateMatch = text.match(/(?:Date|Datum)[:\s]+(\d{4}-\d{2}-\d{2})/i);
    const nameMatch = text.match(/(?:Passenger|Passagier)[:\s]+([A-Za-zÀ-ÿ' -]+)/i);

    if (!refMatch?.[1] || !flightMatch?.[1] || !dateMatch?.[1] || !nameMatch?.[1]) {
      return null;
    }

    return {
      bookingReference: refMatch[1],
      passengerFullName: nameMatch[1].trim(),
      segments: [{ flightNumber: flightMatch[1], scheduledDepartureDateUtc: dateMatch[1] }],
    };
  };
}

describe("looksLikeBookingEmail", () => {
  it("recognizes an English booking confirmation", () => {
    expect(looksLikeBookingEmail(loadFixture("ba-booking-confirmation.json").bodyText)).toBe(true);
  });

  it("recognizes a German booking confirmation", () => {
    expect(looksLikeBookingEmail(loadFixture("lufthansa-booking-confirmation-de.json").bodyText)).toBe(true);
  });

  it("rejects a marketing email", () => {
    expect(looksLikeBookingEmail(loadFixture("marketing-newsletter.json").bodyText)).toBe(false);
  });
});

describe("parseBookingEmail", () => {
  it("extracts correct PNR/flight/date/passenger from an English confirmation", async () => {
    const email = buildEmail(loadFixture("ba-booking-confirmation.json"));
    const result = await parseBookingEmail(email, createFixtureExtractor());

    expect(result).toEqual({
      bookingReference: "XR7K2P",
      passengerFullName: "John Smith",
      segments: [{ flightNumber: "BA123", scheduledDepartureDateUtc: "2024-06-15" }],
    });
  });

  it("extracts correct fields from a non-English (German) confirmation", async () => {
    const email = buildEmail(loadFixture("lufthansa-booking-confirmation-de.json"));
    const result = await parseBookingEmail(email, createFixtureExtractor());

    expect(result).toEqual({
      bookingReference: "9F3K7Q",
      passengerFullName: "Anna Müller",
      segments: [{ flightNumber: "LH456", scheduledDepartureDateUtc: "2024-07-01" }],
    });
  });

  it("rejects a marketing email WITHOUT ever calling the extractor", async () => {
    const email = buildEmail(loadFixture("marketing-newsletter.json"));
    const extractor = vi.fn<BookingExtractor>();

    const result = await parseBookingEmail(email, extractor);

    expect(result).toBeNull();
    expect(extractor).not.toHaveBeenCalled();
  });

  it("returns null if the extractor cannot find all required fields", async () => {
    const email = buildEmail({ subject: "test", bodyText: "Booking reference: ABC123\n(no flight number here)" });
    const result = await parseBookingEmail(email, createFixtureExtractor());
    expect(result).toBeNull();
  });

  it("passes a no-op attachment fetcher to the extractor when none is given", async () => {
    const email = buildEmail(loadFixture("ba-booking-confirmation.json"));
    const extractor = vi.fn<BookingExtractor>().mockResolvedValue(null);

    await parseBookingEmail(email, extractor);

    expect(extractor).toHaveBeenCalledTimes(1);
    const fetchAttachment = extractor.mock.calls[0]?.[1];
    const result = await fetchAttachment!("anything.pdf");
    expect(result.ok).toBe(false);
  });

  it("forwards an explicitly provided attachment fetcher to the extractor", async () => {
    const email = buildEmail(loadFixture("ba-booking-confirmation.json"));
    const extractor = vi.fn<BookingExtractor>().mockResolvedValue(null);
    const fetchAttachment = vi.fn().mockResolvedValue({ ok: true, value: "attachment text" });

    await parseBookingEmail(email, extractor, fetchAttachment);

    expect(extractor.mock.calls[0]?.[1]).toBe(fetchAttachment);
  });
});

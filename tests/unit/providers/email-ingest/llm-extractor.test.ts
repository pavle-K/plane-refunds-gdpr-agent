import { describe, it, expect } from "vitest";
import { createLlmBookingExtractor } from "../../../../src/providers/email-ingest/llm-extractor.js";
import { FakeChatModel } from "../../../../src/agent/llm/fake-chat-model.js";
import { noAttachmentFetcher } from "../../../../src/providers/email-ingest/booking-parser.js";
import { ok, err } from "../../../../src/lib/result.js";
import type { EmailMessage } from "../../../../src/providers/email-ingest/email-ingest.port.js";

function buildEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-1",
    from: "noreply@mytrip.com",
    subject: "Your trip is confirmed",
    receivedAtUtc: "2026-01-01T00:00:00.000Z",
    bodyText: "Booking reference: 9F3K7Q\nPassenger: Jane Doe",
    attachments: [],
    ...overrides,
  };
}

describe("createLlmBookingExtractor", () => {
  it("returns the parsed booking directly when the body text has everything (no tool call)", async () => {
    const llm = new FakeChatModel();
    llm.enqueueStructuredToolCall({
      booking: {
        bookingReference: "9F3K7Q",
        passengerFullName: "Jane Doe",
        segments: [{ flightNumber: "LH456", scheduledDepartureDateUtc: "2026-01-10" }],
      },
    });
    const extractor = createLlmBookingExtractor(llm);

    const result = await extractor(buildEmail(), noAttachmentFetcher);

    expect(result).toEqual({
      bookingReference: "9F3K7Q",
      passengerFullName: "Jane Doe",
      segments: [{ flightNumber: "LH456", scheduledDepartureDateUtc: "2026-01-10" }],
    });
  });

  it("does not offer the get_attachment_text tool when the email has no attachments", async () => {
    const llm = new FakeChatModel();
    llm.enqueueStructuredToolCall({ booking: null });
    const extractor = createLlmBookingExtractor(llm);

    await extractor(buildEmail({ attachments: [] }), noAttachmentFetcher);

    // Only the synthetic responseFormat tool call was made — no get_attachment_text.
    // The exact "extract-N" number isn't stable across a whole test run (see
    // fake-chat-model.test.ts) — only that it's the one and only call, matching
    // the pattern, is what this asserts.
    expect(llm.toolCallsMade).toHaveLength(1);
    expect(llm.toolCallsMade[0]?.name).toMatch(/^extract-\d+$/);
  });

  it("calls get_attachment_text and feeds the extracted text back when the model requests it", async () => {
    const llm = new FakeChatModel();
    llm.enqueueToolCall({ name: "get_attachment_text", args: { filename: "Receipt.pdf" } });
    llm.enqueueStructuredToolCall({
      booking: {
        bookingReference: "9F3K7Q",
        passengerFullName: "Jane Doe",
        segments: [
          { flightNumber: "TK1867", scheduledDepartureDateUtc: "2026-01-10" },
          { flightNumber: "TK57", scheduledDepartureDateUtc: "2026-01-10" },
        ],
      },
    });
    const extractor = createLlmBookingExtractor(llm);

    const fetchAttachment = async (filename: string) => {
      expect(filename).toBe("Receipt.pdf");
      return ok("Turkish Airlines • TK1867\nTurkish Airlines • TK57");
    };

    const email = buildEmail({
      bodyText: "Booking reference: 9F3K7Q\nPassenger: Jane Doe\nSee attached e-ticket.",
      attachments: [{ filename: "Receipt.pdf", mimeType: "application/pdf" }],
    });

    const result = await extractor(email, fetchAttachment);

    expect(result?.segments).toEqual([
      { flightNumber: "TK1867", scheduledDepartureDateUtc: "2026-01-10" },
      { flightNumber: "TK57", scheduledDepartureDateUtc: "2026-01-10" },
    ]);
    expect(llm.toolCallsMade[0]).toEqual({ name: "get_attachment_text", args: { filename: "Receipt.pdf" } });
    expect(llm.toolCallsMade[1]?.name).toMatch(/^extract-\d+$/);
  });

  it("surfaces an attachment fetch failure to the model as a tool error rather than throwing", async () => {
    const llm = new FakeChatModel();
    llm.enqueueToolCall({ name: "get_attachment_text", args: { filename: "missing.pdf" } });
    llm.enqueueStructuredToolCall({ booking: null });
    const extractor = createLlmBookingExtractor(llm);

    const fetchAttachment = async () => err({ type: "not_found" as const, message: "no such attachment" });
    const email = buildEmail({ attachments: [{ filename: "missing.pdf", mimeType: "application/pdf" }] });

    const result = await extractor(email, fetchAttachment);

    expect(result).toBeNull();
  });

  it("returns null when the final response is null even after a tool call", async () => {
    const llm = new FakeChatModel();
    llm.enqueueToolCall({ name: "get_attachment_text", args: { filename: "Receipt.pdf" } });
    llm.enqueueStructuredToolCall({ booking: null });
    const extractor = createLlmBookingExtractor(llm);

    const result = await extractor(
      buildEmail({ attachments: [{ filename: "Receipt.pdf", mimeType: "application/pdf" }] }),
      async () => ok("unrelated text"),
    );

    expect(result).toBeNull();
  });
});

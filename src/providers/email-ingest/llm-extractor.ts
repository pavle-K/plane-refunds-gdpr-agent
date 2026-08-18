import { z } from "zod";
import { createAgent, tool } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { prompts } from "../../agent/prompts/index.js";
import type { BookingExtractor } from "./booking-parser.js";

const bookingDataSchema = z.object({
  bookingReference: z.string(),
  passengerFullName: z.string(),
  segments: z
    .array(
      z.object({
        flightNumber: z.string(),
        scheduledDepartureDateUtc: z.string(),
      }),
    )
    .min(1),
});

// createAgent's responseFormat requires an object schema at the top level
// (StructuredResponseType extends Record<string, any>) — a bare `.nullable()`
// object doesn't satisfy that, so "no booking found" is expressed as a null
// inner field instead of a nullable top-level result.
const extractionSchema = z.object({ booking: bookingDataSchema.nullable() });

/** The real (Stage 2/3) implementation of BookingExtractor — an agentic LLM tool
 * loop using the extract-booking prompt. It reads the email body first, and may
 * call get_attachment_text (backed by the real email provider) if a required
 * field is only present in an attachment (e.g. a PDF ticket). Tests use a fake
 * extractor instead (see booking-parser tests); this is only exercised in the
 * real/end-to-end graph path. */
export function createLlmBookingExtractor(model: BaseChatModel): BookingExtractor {
  return async (email, fetchAttachment) => {
    const attachmentNote =
      email.attachments.length > 0
        ? `\n\nThis email has the following attachment(s) available via get_attachment_text: ${email.attachments
            .map((a) => `"${a.filename}" (${a.mimeType})`)
            .join(", ")}.`
        : "\n\nThis email has no attachments.";

    const getAttachmentText = tool(
      async ({ filename }: { filename: string }) => {
        const result = await fetchAttachment(filename);
        return result.ok ? { text: result.value } : { error: `${result.error.type}: ${result.error.message}` };
      },
      {
        name: "get_attachment_text",
        description:
          "Fetches the extracted text of an email attachment by exact filename. Only call this if the email " +
          "body text alone is missing a required field (booking reference, a flight number, a segment date, or " +
          "the passenger name) AND an attachment that could plausibly contain it is listed as available below. " +
          "Don't call this speculatively if the body already has everything you need.",
        schema: z.object({ filename: z.string().describe("Exact filename as listed") }),
      },
    );

    const agent = createAgent({
      model,
      tools: email.attachments.length > 0 ? [getAttachmentText] : [],
      systemPrompt: prompts.extractBooking + attachmentNote,
      responseFormat: extractionSchema,
    });

    const result = await agent.invoke({
      messages: [new HumanMessage(`Subject: ${email.subject}\n\n${email.bodyText}`)],
    });

    return result.structuredResponse.booking;
  };
}

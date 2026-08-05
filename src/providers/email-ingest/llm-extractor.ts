import { z } from "zod";
import type { LlmClient, LlmToolDefinition } from "../../agent/llm/client.js";
import { callStructuredWithTools } from "../../agent/llm/structured.js";
import { prompts } from "../../agent/prompts/index.js";
import type { BookingExtractor } from "./booking-parser.js";

const bookingSchema = z
  .object({
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
  })
  .nullable();

const GET_ATTACHMENT_TEXT_TOOL: LlmToolDefinition = {
  name: "get_attachment_text",
  description:
    "Fetches the extracted text of an email attachment by exact filename. Only call this if the email body " +
    "text alone is missing a required field (booking reference, a flight number, a segment date, or the " +
    "passenger name) AND an attachment that could plausibly contain it is listed as available below. Don't " +
    "call this speculatively if the body already has everything you need.",
  inputSchema: {
    type: "object",
    properties: { filename: { type: "string", description: "Exact filename as listed" } },
    required: ["filename"],
  },
};

/** The real (Stage 2/3) implementation of BookingExtractor — an agentic LLM tool
 * loop using the extract-booking prompt. It reads the email body first, and may
 * call get_attachment_text (backed by the real email provider) if a required
 * field is only present in an attachment (e.g. a PDF ticket). Tests use a fake
 * extractor instead (see booking-parser tests); this is only exercised in the
 * real/end-to-end graph path. */
export function createLlmBookingExtractor(llm: LlmClient): BookingExtractor {
  return async (email, fetchAttachment) => {
    const attachmentNote =
      email.attachments.length > 0
        ? `\n\nThis email has the following attachment(s) available via get_attachment_text: ${email.attachments
            .map((a) => `"${a.filename}" (${a.mimeType})`)
            .join(", ")}.`
        : "\n\nThis email has no attachments.";

    return callStructuredWithTools(llm, {
      system: prompts.extractBooking + attachmentNote,
      prompt: `Subject: ${email.subject}\n\n${email.bodyText}`,
      schema: bookingSchema,
      tools: email.attachments.length > 0 ? [GET_ATTACHMENT_TEXT_TOOL] : [],
      onToolCall: async (call) => {
        if (call.name !== "get_attachment_text") {
          return JSON.stringify({ error: `Unknown tool "${call.name}"` });
        }
        const filename = call.input["filename"];
        if (typeof filename !== "string") {
          return JSON.stringify({ error: "filename must be a string" });
        }
        const result = await fetchAttachment(filename);
        if (!result.ok) {
          return JSON.stringify({ error: `${result.error.type}: ${result.error.message}` });
        }
        return JSON.stringify({ text: result.value });
      },
    });
  };
}

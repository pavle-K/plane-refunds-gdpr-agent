import { z } from "zod";
import type { LlmClient } from "../../agent/llm/client.js";
import { callStructured } from "../../agent/llm/structured.js";
import { prompts } from "../../agent/prompts/index.js";
import type { BookingExtractor } from "./booking-parser.js";

const bookingSchema = z
  .object({
    bookingReference: z.string(),
    flightNumber: z.string(),
    scheduledDepartureDateUtc: z.string(),
    passengerFullName: z.string(),
  })
  .nullable();

/** The real (Stage 2) implementation of BookingExtractor — an LLM call using the
 * extract-booking prompt. Tests use a fake extractor instead (see booking-parser
 * tests); this is only exercised in the real/end-to-end graph path. */
export function createLlmBookingExtractor(llm: LlmClient): BookingExtractor {
  return async (emailBodyText) => {
    return callStructured(llm, {
      system: prompts.extractBooking,
      prompt: emailBodyText,
      schema: bookingSchema,
    });
  };
}

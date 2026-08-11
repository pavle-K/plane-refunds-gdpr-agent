import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ok, err, type Result } from "../../lib/result.js";
import type {
  AirlineDirectoryProvider,
  AirlineClaimsContact,
  AirlineDirectoryError,
} from "./airline-directory.port.js";

/**
 * Seeded from carrier codes/names/EU status, which are stable public facts.
 * Every entry's submissionMethod is currently "unsupported" — none of these
 * have a sourced, verified claims channel yet. That's an honest reflection of
 * reality, not a placeholder pretending to be data: a guessed real airline
 * claims address/form is worse than none, since a wrong one means a claim
 * silently never reaches the airline. Source and verify a real channel from
 * each airline's official passenger-rights page before flipping an entry to
 * "email" or "web_form" — see the port's ClaimSubmissionMethod doc comment.
 * knownRejectionPatterns starts empty; it's meant to be a living dataset informed
 * by real claim outcomes over time, not something to fill in from general knowledge.
 */
const DATA_PATH = fileURLToPath(new URL("./data/airlines.json", import.meta.url));

const passengerFieldKeySchema = z.enum(["fullName", "address", "contactEmail", "phone", "iban"]);

const submissionMethodSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("email"),
    claimsEmail: z.string().email(),
    requiredFields: z.array(passengerFieldKeySchema),
  }),
  z.object({
    type: z.literal("web_form"),
    formUrl: z.string().url(),
    requiredFields: z.array(passengerFieldKeySchema),
    formNotes: z.string().optional(),
  }),
  z.object({
    type: z.literal("unsupported"),
    reason: z.string().min(1),
  }),
]);

const airlineClaimsContactSchema = z.object({
  carrierIataCode: z.string().min(2),
  carrierName: z.string().min(1),
  isEuCarrier: z.boolean(),
  submissionMethod: submissionMethodSchema,
  knownRejectionPatterns: z.array(z.string()),
});

function loadDirectory(): AirlineClaimsContact[] {
  const raw = readFileSync(DATA_PATH, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  const result = z.array(airlineClaimsContactSchema).safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid airline directory data (${DATA_PATH}): ${result.error.message}`);
  }
  return result.data;
}

export class StaticAirlineDirectoryAdapter implements AirlineDirectoryProvider {
  private readonly byCode: Map<string, AirlineClaimsContact>;

  /** Loaded and validated at construction — a malformed entry fails the moment
   * this adapter is built, not the first time some node happens to look up
   * that specific carrier (same convention as prompts/index.ts). */
  constructor() {
    const entries = loadDirectory();
    this.byCode = new Map(entries.map((entry) => [entry.carrierIataCode.toUpperCase(), entry]));
  }

  async getAirline(
    carrierIataCode: string,
  ): Promise<Result<AirlineClaimsContact, AirlineDirectoryError>> {
    const entry = this.byCode.get(carrierIataCode.toUpperCase());
    if (!entry) {
      return err({
        type: "not_found",
        message: `No directory entry for carrier code: ${carrierIataCode}`,
      });
    }
    return ok(entry);
  }

  async listAirlines(): Promise<AirlineClaimsContact[]> {
    return [...this.byCode.values()];
  }
}

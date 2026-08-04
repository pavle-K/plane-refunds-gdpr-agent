import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ok, err, type Result } from "../../lib/result.js";
import type {
  AirlineDirectoryProvider,
  AirlineClaimsContact,
  AirlineDirectoryError,
} from "./airline-directory.port.js";

/**
 * Seeded from carrier codes/names/EU status, which are stable public facts.
 * claimsEmail is intentionally a placeholder ("REPLACE-ME.example") for every
 * entry — a guessed real airline claims address is worse than none, since a wrong
 * address means a claim silently never reaches the airline. Source real addresses
 * from each airline's official passenger-rights page before sending anything.
 * knownRejectionPatterns starts empty; it's meant to be a living dataset informed
 * by real claim outcomes over time, not something to fill in from general knowledge.
 */
const DATA_PATH = fileURLToPath(new URL("./data/airlines.json", import.meta.url));

export class StaticAirlineDirectoryAdapter implements AirlineDirectoryProvider {
  private readonly byCode: Map<string, AirlineClaimsContact>;

  constructor() {
    const raw = readFileSync(DATA_PATH, "utf-8");
    const entries = JSON.parse(raw) as AirlineClaimsContact[];
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
}

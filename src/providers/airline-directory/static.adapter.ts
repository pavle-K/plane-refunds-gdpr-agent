import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ok, err, type Result } from "../../lib/result.js";
import type {
  AirlineClaimsContact,
  AirlineDirectoryError,
  AirlineDirectoryProvider,
} from "./airline-directory.port.js";
import type { AirlineDirectoryMaintenanceView, CarrierResearch } from "./maintenance.js";
import { directorySchema, toLoadedCarrier } from "./schema.js";

const DATA_PATH = fileURLToPath(new URL("./data/airlines.json", import.meta.url));

interface Directory {
  contacts: Map<string, AirlineClaimsContact>;
  research: Map<string, CarrierResearch>;
}

function loadDirectory(): Directory {
  const raw = readFileSync(DATA_PATH, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  const result = directorySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid airline directory data (${DATA_PATH}): ${result.error.message}`);
  }

  const contacts = new Map<string, AirlineClaimsContact>();
  const research = new Map<string, CarrierResearch>();
  for (const rawCarrier of result.data) {
    const loaded = toLoadedCarrier(rawCarrier);
    const code = loaded.contact.carrierIataCode.toUpperCase();
    contacts.set(code, loaded.contact);
    research.set(code, loaded.research);
  }
  return { contacts, research };
}

/**
 * The real dataset. Also implements AirlineDirectoryMaintenanceView, but note
 * that the factory in index.ts declares its return type as
 * AirlineDirectoryProvider — so nothing injected through GraphDeps can see the
 * research side, even though this class holds it. See maintenance.ts for why
 * that separation exists.
 */
export class StaticAirlineDirectoryAdapter implements AirlineDirectoryProvider, AirlineDirectoryMaintenanceView {
  private readonly contacts: Map<string, AirlineClaimsContact>;
  private readonly research: Map<string, CarrierResearch>;

  /** Loaded and validated at construction — a malformed entry, an unmapped
   * required-field token, a duplicate carrier code or an unresolved URL
   * template fails the moment this adapter is built, not the first time some
   * node happens to look up that specific carrier (same convention as
   * prompts/index.ts). */
  constructor() {
    const { contacts, research } = loadDirectory();
    this.contacts = contacts;
    this.research = research;
  }

  async getAirline(carrierIataCode: string): Promise<Result<AirlineClaimsContact, AirlineDirectoryError>> {
    const entry = this.contacts.get(carrierIataCode.toUpperCase());
    if (!entry) {
      return err({
        type: "not_found",
        message: `No directory entry for carrier code: ${carrierIataCode}`,
      });
    }
    return ok(entry);
  }

  async listAirlines(): Promise<AirlineClaimsContact[]> {
    return [...this.contacts.values()];
  }

  async getResearch(carrierIataCode: string): Promise<CarrierResearch | null> {
    return this.research.get(carrierIataCode.toUpperCase()) ?? null;
  }
}

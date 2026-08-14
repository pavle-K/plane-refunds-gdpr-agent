import { env } from "../../config/env.js";
import type { AirportReferenceProvider } from "./airport-reference.port.js";
import { FakeAirportReferenceAdapter } from "./fake.adapter.js";
import { DbAirportReferenceAdapter } from "./db.adapter.js";
import { AirportRepo } from "../../db/repositories/airport.repo.js";

export * from "./airport-reference.port.js";
export { FakeAirportReferenceAdapter, buildAirportFacts } from "./fake.adapter.js";
export { DbAirportReferenceAdapter } from "./db.adapter.js";

/** No DATABASE_URL means no `airports` table to query — same fallback
 * convention as every other provider's factory (e.g. flight-status/index.ts). */
export function createAirportReferenceProvider(): AirportReferenceProvider {
  if (env.NODE_ENV === "test" || !env.DATABASE_URL) {
    return new FakeAirportReferenceAdapter();
  }
  return new DbAirportReferenceAdapter(new AirportRepo(), env.FLIGHT_DATA_API_KEY);
}

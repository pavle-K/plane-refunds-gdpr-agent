import type { AirlineDirectoryProvider } from "./airline-directory.port.js";
import { StaticAirlineDirectoryAdapter } from "./static.adapter.js";

export * from "./airline-directory.port.js";
export { StaticAirlineDirectoryAdapter } from "./static.adapter.js";
export { FakeAirlineDirectoryAdapter, buildAirlineClaimsContact, buildAnyCodeEmailAirlineDirectory } from "./fake.adapter.js";

/** The static dataset is deterministic and offline, so it doubles as its own test double. */
export function createAirlineDirectoryProvider(): AirlineDirectoryProvider {
  return new StaticAirlineDirectoryAdapter();
}

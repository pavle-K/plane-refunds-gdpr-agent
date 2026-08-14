import type { AirlineDirectoryProvider } from "./airline-directory.port.js";
import { StaticAirlineDirectoryAdapter } from "./static.adapter.js";

export * from "./airline-directory.port.js";
export * from "./submission-plan.js";
export { StaticAirlineDirectoryAdapter } from "./static.adapter.js";
export {
  FakeAirlineDirectoryAdapter,
  buildAirlineClaimsContact,
  buildAnyCodeEmailAirlineDirectory,
  buildAnyCodeWebFormAirlineDirectory,
  buildWebFormChannel,
  buildUnverifiedWebFormChannel,
  buildEmailChannel,
  buildPostalChannel,
} from "./fake.adapter.js";

// NOTE: ./maintenance.js is deliberately NOT re-exported here. Research prose
// must not be reachable from the barrel that agent nodes and operator tools
// import from — see that module's doc comment for the incident this prevents.
// Anything that genuinely needs it imports it by path and says so.

/**
 * The static dataset is deterministic and offline, so it doubles as its own
 * test double. Declared as AirlineDirectoryProvider, not as the concrete class:
 * that keeps the maintenance view off the type everything downstream receives.
 */
export function createAirlineDirectoryProvider(): AirlineDirectoryProvider {
  return new StaticAirlineDirectoryAdapter();
}

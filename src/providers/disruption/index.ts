import type { DisruptionProvider } from "./disruption.port.js";
import { FakeDisruptionAdapter } from "./fake.adapter.js";

export * from "./disruption.port.js";
export { FakeDisruptionAdapter } from "./fake.adapter.js";

/**
 * No real adapter exists yet. Unlike flight-status/weather, there isn't an obvious
 * free structured feed for "was there an ATC strike at this airport on this date" —
 * NOTAMs are closer (EUROCONTROL Network Manager) but need registration, and ATC
 * strikes specifically are usually reported as news, not structured data. Needs a
 * source decision before a real adapter is worth writing.
 */
export function createDisruptionProvider(): DisruptionProvider {
  return new FakeDisruptionAdapter();
}

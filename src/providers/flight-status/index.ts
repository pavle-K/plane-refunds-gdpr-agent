import { env } from "../../config/env.js";
import type { FlightStatusProvider } from "./flight-status.port.js";
import { FakeFlightStatusAdapter } from "./fake.adapter.js";
import { AeroApiFlightStatusAdapter } from "./aeroapi.adapter.js";

export * from "./flight-status.port.js";
export { FakeFlightStatusAdapter, buildOnTimeResult } from "./fake.adapter.js";
export { AeroApiFlightStatusAdapter } from "./aeroapi.adapter.js";

export function createFlightStatusProvider(): FlightStatusProvider {
  if (env.NODE_ENV === "test" || !env.FLIGHT_DATA_API_KEY) {
    return new FakeFlightStatusAdapter();
  }
  return new AeroApiFlightStatusAdapter(env.FLIGHT_DATA_API_KEY);
}

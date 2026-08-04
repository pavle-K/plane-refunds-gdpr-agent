import { env } from "../../config/env.js";
import type { WeatherProvider } from "./weather.port.js";
import { FakeWeatherAdapter } from "./fake.adapter.js";
import { IemAsosWeatherAdapter } from "./iem-asos.adapter.js";

export * from "./weather.port.js";
export { FakeWeatherAdapter, buildClearSkyObservation } from "./fake.adapter.js";
export { IemAsosWeatherAdapter } from "./iem-asos.adapter.js";

/** The IEM ASOS archive is free and keyless, so the real adapter is always available. */
export function createWeatherProvider(): WeatherProvider {
  if (env.NODE_ENV === "test") {
    return new FakeWeatherAdapter();
  }
  return new IemAsosWeatherAdapter();
}

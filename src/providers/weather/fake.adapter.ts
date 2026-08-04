import { err, type Result } from "../../lib/result.js";
import type { WeatherProvider, WeatherQuery, WeatherObservation, WeatherError } from "./weather.port.js";

function key(query: WeatherQuery): string {
  return `${query.icaoCode.toUpperCase()}_${query.atUtc}`;
}

/** In-memory adapter for tests and local dev. Seed it, never hits the network. */
export class FakeWeatherAdapter implements WeatherProvider {
  private readonly seeded = new Map<string, Result<WeatherObservation, WeatherError>>();

  seed(query: WeatherQuery, result: Result<WeatherObservation, WeatherError>): void {
    this.seeded.set(key(query), result);
  }

  async getObservation(query: WeatherQuery): Promise<Result<WeatherObservation, WeatherError>> {
    const seededResult = this.seeded.get(key(query));
    if (seededResult) {
      return seededResult;
    }
    return err({
      type: "not_found",
      message: `No fixture seeded for ${query.icaoCode} near ${query.atUtc}`,
    });
  }
}

export function buildClearSkyObservation(overrides: Partial<WeatherObservation> = {}): WeatherObservation {
  return {
    icaoCode: "EGLL",
    observedAtUtc: "2024-06-15T10:00:00.000Z",
    visibilityMeters: 10000,
    ceilingFeet: null,
    windSpeedKnots: 10,
    windGustKnots: null,
    thunderstorm: false,
    rawMetar: "METAR EGLL 151000Z 21010KT 9999 NCD 20/12 Q1015",
    ...overrides,
  };
}

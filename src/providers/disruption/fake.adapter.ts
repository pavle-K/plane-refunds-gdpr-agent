import { ok, type Result } from "../../lib/result.js";
import type { DisruptionProvider, DisruptionQuery, DisruptionEvent, DisruptionError } from "./disruption.port.js";

function key(query: DisruptionQuery): string {
  return `${query.airportIata.toUpperCase()}_${query.dateUtc}`;
}

/** In-memory adapter for tests and local dev. Seed it, never hits the network. */
export class FakeDisruptionAdapter implements DisruptionProvider {
  private readonly seeded = new Map<string, Result<DisruptionEvent[], DisruptionError>>();

  seed(query: DisruptionQuery, result: Result<DisruptionEvent[], DisruptionError>): void {
    this.seeded.set(key(query), result);
  }

  async getDisruptions(query: DisruptionQuery): Promise<Result<DisruptionEvent[], DisruptionError>> {
    return this.seeded.get(key(query)) ?? ok([]);
  }
}

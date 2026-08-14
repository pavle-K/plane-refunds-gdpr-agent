import { describe, it, expect, afterEach, vi } from "vitest";
import { DbAirportReferenceAdapter } from "../../../../src/providers/airport-reference/db.adapter.js";
import type { AirportRepo, AirportRow } from "../../../../src/db/repositories/airport.repo.js";

/** In-memory stand-in for AirportRepo — this suite is a unit test of the
 * adapter's caching/fallback/persistence LOGIC, not of real SQL, so a plain
 * Map is enough; AirportRepo itself has no logic of its own to test beyond
 * the query it issues. */
class StubAirportRepo {
  private readonly rows = new Map<string, AirportRow>();
  readonly upsertCalls: AirportRow[] = [];

  seed(row: AirportRow): void {
    this.rows.set(row.iataCode, row);
  }

  async findByIata(iataCode: string): Promise<AirportRow | null> {
    return this.rows.get(iataCode.toUpperCase()) ?? null;
  }

  async upsert(row: AirportRow): Promise<void> {
    this.upsertCalls.push(row);
    this.rows.set(row.iataCode.toUpperCase(), row);
  }

  async bulkUpsert(rows: AirportRow[]): Promise<void> {
    for (const row of rows) await this.upsert(row);
  }
}

function mockFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Shape hand-verified against a live AeroAPI /airports/{id} call (see
// db.adapter.ts's doc comment) for PMO on 2026-08-11.
const PMO_AEROAPI_RESPONSE = {
  airport_code: "LICJ",
  code_icao: "LICJ",
  code_iata: "PMO",
  name: "Palermo Int'l (Punta Raisi Falcone-Borsellino)",
  latitude: 38.175958,
  longitude: 13.091019,
  country_code: "IT",
};

describe("DbAirportReferenceAdapter — cache hit", () => {
  it("returns the DB row without ever calling fetch", async () => {
    const repo = new StubAirportRepo();
    repo.seed({ iataCode: "MAD", icaoCode: "LEMD", name: "Madrid", countryIsoCode: "ES", latitude: 40.4983, longitude: -3.5676, source: "ourairports" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = new DbAirportReferenceAdapter(repo as unknown as AirportRepo, "fake-key");
    const result = await adapter.getAirport("mad");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.icaoCode).toBe("LEMD");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("DbAirportReferenceAdapter — self-healing fallback", () => {
  it("resolves a missing code via AeroAPI and persists it for next time", async () => {
    const repo = new StubAirportRepo();
    mockFetchOnce(PMO_AEROAPI_RESPONSE);

    const adapter = new DbAirportReferenceAdapter(repo as unknown as AirportRepo, "fake-key");
    const result = await adapter.getAirport("PMO");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        iataCode: "PMO",
        icaoCode: "LICJ",
        name: "Palermo Int'l (Punta Raisi Falcone-Borsellino)",
        countryIsoCode: "IT",
        latitude: 38.175958,
        longitude: 13.091019,
      });
    }
    expect(repo.upsertCalls).toHaveLength(1);
    expect(repo.upsertCalls[0]?.source).toBe("aeroapi_lookup");
  });

  it("returns not_found without a network call when no API key is configured", async () => {
    const repo = new StubAirportRepo();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = new DbAirportReferenceAdapter(repo as unknown as AirportRepo, undefined);
    const result = await adapter.getAirport("PMO");

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats AeroAPI's 400/NO_DATA response (nonexistent-but-well-formed code) as not_found", async () => {
    const repo = new StubAirportRepo();
    mockFetchOnce({ title: "No data", reason: "NO_DATA", status: 400 }, 400);

    const adapter = new DbAirportReferenceAdapter(repo as unknown as AirportRepo, "fake-key");
    const result = await adapter.getAirport("ZZZ");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it("returns rate_limited on HTTP 429, never silently succeeding", async () => {
    const repo = new StubAirportRepo();
    mockFetchOnce(null, 429);

    const adapter = new DbAirportReferenceAdapter(repo as unknown as AirportRepo, "fake-key");
    const result = await adapter.getAirport("PMO");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("rate_limited");
    }
  });

  it("returns upstream_error rather than a half-populated result when a required field is missing", async () => {
    const repo = new StubAirportRepo();
    mockFetchOnce({ ...PMO_AEROAPI_RESPONSE, latitude: null });

    const adapter = new DbAirportReferenceAdapter(repo as unknown as AirportRepo, "fake-key");
    const result = await adapter.getAirport("PMO");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it("returns upstream_error when country_code isn't a well-formed 2-letter code", async () => {
    const repo = new StubAirportRepo();
    mockFetchOnce({ ...PMO_AEROAPI_RESPONSE, country_code: "Italy" });

    const adapter = new DbAirportReferenceAdapter(repo as unknown as AirportRepo, "fake-key");
    const result = await adapter.getAirport("PMO");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });

  it("returns upstream_error on a network failure", async () => {
    const repo = new StubAirportRepo();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    const adapter = new DbAirportReferenceAdapter(repo as unknown as AirportRepo, "fake-key");
    const result = await adapter.getAirport("PMO");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });
});

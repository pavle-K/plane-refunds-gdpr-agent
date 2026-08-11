import { ok, err, type Result } from "../../lib/result.js";
import type { AirportReferenceProvider, AirportFacts, AirportReferenceError } from "./airport-reference.port.js";
import type { AirportRepo, AirportRow } from "../../db/repositories/airport.repo.js";

const BASE_URL = "https://aeroapi.flightaware.com/aeroapi";

interface AeroApiAirport {
  code_iata: string | null;
  code_icao: string | null;
  name: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
}

function toFacts(row: AirportRow): AirportFacts {
  return {
    iataCode: row.iataCode,
    icaoCode: row.icaoCode,
    name: row.name,
    countryIsoCode: row.countryIsoCode,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

/**
 * Real adapter. The `airports` table (bulk-imported from OurAirports by
 * scripts/import-airports.ts — see schema.ts's doc comment) is checked first,
 * so the overwhelming majority of lookups never touch the network. On a
 * genuine miss (a code the import didn't cover), this falls back to a live
 * AeroAPI `/airports/{id}` lookup and persists whatever it resolves, so the
 * same code never needs the network path again — see AirportRepo.upsert.
 *
 * The `/airports/{id}` endpoint's shape below IS hand-verified against a live
 * call (2026-08-11: PMO, JFK, and a nonexistent code) — this endpoint wasn't
 * used anywhere in this codebase before, so this is a first verification, not
 * a reuse of aeroapi.adapter.ts's (separate) verification of the /flights
 * endpoint. Confirmed fields: code_iata, code_icao, name, latitude, longitude,
 * country_code (2-letter ISO, e.g. "IT" for Palermo). A well-formed but
 * nonexistent code returns HTTP 400 with reason "NO_DATA" — NOT 404 — and a
 * malformed code returns 400 "INVALID_ARGUMENT"; both are treated as
 * not_found here since either way there's no data to use.
 */
export class DbAirportReferenceAdapter implements AirportReferenceProvider {
  constructor(
    private readonly repo: AirportRepo,
    private readonly aeroApiKey: string | undefined,
  ) {}

  async getAirport(iataCode: string): Promise<Result<AirportFacts, AirportReferenceError>> {
    const code = iataCode.toUpperCase();

    const cached = await this.repo.findByIata(code);
    if (cached) {
      return ok(toFacts(cached));
    }

    if (!this.aeroApiKey) {
      return err({
        type: "not_found",
        message: `No airport reference data for IATA code: ${code}, and no fallback lookup is configured (FLIGHT_DATA_API_KEY unset).`,
      });
    }

    const resolved = await this.resolveViaAeroApi(code);
    if (!resolved.ok) {
      return resolved;
    }

    // Persisted so this exact code never needs the network fallback again —
    // see schema.ts's airports table doc comment on the "aeroapi_lookup" source tag.
    await this.repo.upsert({ ...resolved.value, source: "aeroapi_lookup" });
    return ok(resolved.value);
  }

  private async resolveViaAeroApi(code: string): Promise<Result<AirportFacts, AirportReferenceError>> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/airports/${encodeURIComponent(code)}`, {
        headers: { "x-apikey": this.aeroApiKey! },
      });
    } catch (cause) {
      return err({
        type: "upstream_error",
        message: `Network error calling AeroAPI airports lookup: ${String(cause)}`,
      });
    }

    if (response.status === 401 || response.status === 403) {
      return err({ type: "upstream_error", message: "AeroAPI rejected the API key on the airports lookup" });
    }
    // /airports/{id} returns 400 for both "well-formed but unknown" (reason
    // NO_DATA) and "malformed code" (reason INVALID_ARGUMENT) — never 404.
    // Neither is a server error, and either way there's nothing to resolve.
    if (response.status === 400) {
      return err({ type: "not_found", message: `AeroAPI has no airport data for ${code}` });
    }
    if (response.status === 429) {
      return err({ type: "rate_limited", message: "AeroAPI rate-limited the airports lookup" });
    }
    if (!response.ok) {
      const bodyText = await response.text();
      return err({
        type: "upstream_error",
        message: `AeroAPI airports lookup returned HTTP ${response.status}: ${bodyText}`,
      });
    }

    let body: AeroApiAirport;
    try {
      body = (await response.json()) as AeroApiAirport;
    } catch (cause) {
      return err({ type: "upstream_error", message: `Malformed AeroAPI airports response: ${String(cause)}` });
    }

    return this.parseAirport(code, body);
  }

  /** Never trusts a half-populated response — a wrong/garbled coordinate or
   * country code silently accepted here would produce a wrong distance band or
   * a wrong EU-coverage call downstream, both real-money mistakes (same
   * philosophy as aeroapi.adapter.ts's toFlightStatusResult). */
  private parseAirport(requestedCode: string, body: AeroApiAirport): Result<AirportFacts, AirportReferenceError> {
    const iataCode = body.code_iata?.toUpperCase();
    const countryIsoCode = body.country_code?.toUpperCase();

    if (
      !iataCode ||
      !body.code_icao ||
      !body.name ||
      !countryIsoCode ||
      !/^[A-Z]{2}$/.test(countryIsoCode) ||
      typeof body.latitude !== "number" ||
      typeof body.longitude !== "number"
    ) {
      return err({
        type: "upstream_error",
        message: `AeroAPI airports response for ${requestedCode} was missing or had malformed required fields`,
      });
    }

    return ok({
      iataCode,
      icaoCode: body.code_icao,
      name: body.name,
      countryIsoCode,
      latitude: body.latitude,
      longitude: body.longitude,
    });
  }
}

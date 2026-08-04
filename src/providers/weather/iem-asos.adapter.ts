import { ok, err, type Result } from "../../lib/result.js";
import type { WeatherProvider, WeatherQuery, WeatherObservation, WeatherError } from "./weather.port.js";

/**
 * Real adapter against the Iowa Environmental Mesonet's free ASOS/METAR archive.
 * Chosen over aviationweather.gov's live API specifically because it supports
 * arbitrary HISTORICAL date ranges with no API key — contesting an
 * "extraordinary circumstances" claim means looking up weather at the time of a
 * past disruption, not current conditions. Verified against the live endpoint
 * during development (see chat/commit history); re-verify column names if this
 * starts failing, since it's an unversioned public API with no formal SLA.
 */
const BASE_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const WINDOW_MINUTES_BEFORE = 30;
const WINDOW_MINUTES_AFTER = 15;
const COLUMNS = ["sknt", "gust", "vsby", "skyc1", "skyl1", "skyc2", "skyl2", "skyc3", "skyl3", "wxcodes", "metar"];

interface AsosRow {
  station: string;
  valid: string;
  sknt: string;
  gust: string;
  vsby: string;
  skyc1: string;
  skyl1: string;
  skyc2: string;
  skyl2: string;
  skyc3: string;
  skyl3: string;
  wxcodes: string;
  metar: string;
}

function buildUrl(icaoCode: string, atUtc: Date): string {
  const start = new Date(atUtc.getTime() - WINDOW_MINUTES_BEFORE * 60_000);
  const end = new Date(atUtc.getTime() + WINDOW_MINUTES_AFTER * 60_000);

  const params = new URLSearchParams({
    station: icaoCode,
    data: COLUMNS.join(","),
    year1: String(start.getUTCFullYear()),
    month1: String(start.getUTCMonth() + 1),
    day1: String(start.getUTCDate()),
    hour1: String(start.getUTCHours()),
    minute1: String(start.getUTCMinutes()),
    year2: String(end.getUTCFullYear()),
    month2: String(end.getUTCMonth() + 1),
    day2: String(end.getUTCDate()),
    hour2: String(end.getUTCHours()),
    minute2: String(end.getUTCMinutes()),
    tz: "Etc/UTC",
    format: "onlycomma",
    latlon: "no",
    missing: "M",
    trace: "T",
    direct: "no",
  });

  return `${BASE_URL}?${params.toString()}`;
}

function parseCsv(csv: string): AsosRow[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) {
    return [];
  }
  const header = lines[0]?.split(",") ?? [];
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((col, i) => {
      row[col] = cells[i] ?? "M";
    });
    return row as unknown as AsosRow;
  });
}

function parseMaybeNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "M" || raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const STATUTE_MILE_TO_METERS = 1609.344;

function computeCeilingFeet(row: AsosRow): number | null {
  const layers: Array<[string, string]> = [
    [row.skyc1, row.skyl1],
    [row.skyc2, row.skyl2],
    [row.skyc3, row.skyl3],
  ];

  let ceiling: number | null = null;
  for (const [cover, base] of layers) {
    if (cover === "BKN" || cover === "OVC") {
      const baseFeet = parseMaybeNumber(base);
      if (baseFeet !== null && (ceiling === null || baseFeet < ceiling)) {
        ceiling = baseFeet;
      }
    }
  }
  return ceiling;
}

function parseValidTimestamp(valid: string): string {
  // "YYYY-MM-DD HH:MM" already in UTC (requested via tz=Etc/UTC).
  return new Date(`${valid.replace(" ", "T")}Z`).toISOString();
}

function toObservation(icaoCode: string, row: AsosRow): WeatherObservation {
  const visibilityMiles = parseMaybeNumber(row.vsby);
  return {
    icaoCode,
    observedAtUtc: parseValidTimestamp(row.valid),
    visibilityMeters: visibilityMiles === null ? null : Math.round(visibilityMiles * STATUTE_MILE_TO_METERS),
    ceilingFeet: computeCeilingFeet(row),
    windSpeedKnots: parseMaybeNumber(row.sknt),
    windGustKnots: parseMaybeNumber(row.gust),
    thunderstorm: row.wxcodes !== "M" && row.wxcodes.toUpperCase().includes("TS"),
    rawMetar: row.metar,
  };
}

export class IemAsosWeatherAdapter implements WeatherProvider {
  async getObservation(query: WeatherQuery): Promise<Result<WeatherObservation, WeatherError>> {
    const atUtc = new Date(query.atUtc);
    const url = buildUrl(query.icaoCode, atUtc);

    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      return err({ type: "upstream_error", message: `Network error fetching METAR data: ${String(cause)}` });
    }

    if (response.status === 429) {
      return err({ type: "rate_limited", message: "IEM ASOS archive rate-limited the request" });
    }
    if (!response.ok) {
      return err({ type: "upstream_error", message: `IEM ASOS archive returned HTTP ${response.status}` });
    }

    const csv = await response.text();
    const rows = parseCsv(csv);
    if (rows.length === 0) {
      return err({
        type: "not_found",
        message: `No METAR observation found for ${query.icaoCode} near ${query.atUtc}`,
      });
    }

    const closest = rows.reduce((best, row) => {
      const bestDelta = Math.abs(new Date(parseValidTimestamp(best.valid)).getTime() - atUtc.getTime());
      const rowDelta = Math.abs(new Date(parseValidTimestamp(row.valid)).getTime() - atUtc.getTime());
      return rowDelta < bestDelta ? row : best;
    });

    return ok(toObservation(query.icaoCode, closest));
  }
}

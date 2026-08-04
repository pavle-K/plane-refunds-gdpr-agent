import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IemAsosWeatherAdapter } from "../../../../src/providers/weather/iem-asos.adapter.js";

// Column order the real adapter parses via a CSV header row — fixtures are stored
// as JSON row objects for readability, then flattened to CSV text here, since
// that's the wire format the real IEM endpoint actually returns.
const CSV_COLUMNS = [
  "station",
  "valid",
  "sknt",
  "gust",
  "vsby",
  "skyc1",
  "skyl1",
  "skyc2",
  "skyl2",
  "skyc3",
  "skyl3",
  "wxcodes",
  "metar",
];

function rowsToCsv(rows: Record<string, string>[]): string {
  const lines = rows.map((row) => CSV_COLUMNS.map((col) => row[col] ?? "M").join(","));
  return [CSV_COLUMNS.join(","), ...lines].join("\n");
}

function loadFixture(name: string): string {
  const path = fileURLToPath(new URL(`../../../fixtures/weather/${name}`, import.meta.url));
  const rows = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>[];
  return rowsToCsv(rows);
}

function mockFetchOnce(body: string, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IemAsosWeatherAdapter — parsing", () => {
  it("maps a clear-sky recorded response to the correct internal type", async () => {
    mockFetchOnce(loadFixture("clear.json"));
    const adapter = new IemAsosWeatherAdapter();

    const result = await adapter.getObservation({ icaoCode: "EGLL", atUtc: "2024-06-15T10:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.icaoCode).toBe("EGLL");
      expect(result.value.visibilityMeters).toBe(16093); // 10 statute miles
      expect(result.value.ceilingFeet).toBeNull(); // CLR — no ceiling
      expect(result.value.thunderstorm).toBe(false);
      expect(result.value.windGustKnots).toBeNull(); // "M" in fixture
      expect(result.value.observedAtUtc).toBe("2024-06-15T10:00:00.000Z");
    }
  });

  it("picks the observation closest to the requested time from multiple rows", async () => {
    mockFetchOnce(loadFixture("clear.json"));
    const adapter = new IemAsosWeatherAdapter();

    const result = await adapter.getObservation({ icaoCode: "EGLL", atUtc: "2024-06-15T10:18:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.observedAtUtc).toBe("2024-06-15T10:20:00.000Z");
    }
  });

  it("computes ceiling from the lowest BKN/OVC layer, ignoring FEW, and detects thunderstorm codes", async () => {
    mockFetchOnce(loadFixture("low-ceiling-thunderstorm.json"));
    const adapter = new IemAsosWeatherAdapter();

    const result = await adapter.getObservation({ icaoCode: "KJFK", atUtc: "2024-01-15T01:51:00.000Z" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ceilingFeet).toBe(1200); // BKN at 1200 is lower than OVC at 2500; FEW 800 ignored
      expect(result.value.thunderstorm).toBe(true);
      expect(result.value.windGustKnots).toBe(38);
      expect(result.value.windSpeedKnots).toBe(28);
    }
  });
});

describe("IemAsosWeatherAdapter — failure modes", () => {
  it("returns a typed not_found error when no rows are returned, never a partial object", async () => {
    mockFetchOnce(loadFixture("empty.json"));
    const adapter = new IemAsosWeatherAdapter();

    const result = await adapter.getObservation({ icaoCode: "ZZZZ", atUtc: "2024-01-01T00:00:00.000Z" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("returns a typed rate_limited error on HTTP 429", async () => {
    mockFetchOnce("", 429);
    const adapter = new IemAsosWeatherAdapter();

    const result = await adapter.getObservation({ icaoCode: "EGLL", atUtc: "2024-01-01T00:00:00.000Z" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("rate_limited");
    }
  });

  it("returns a typed upstream_error on a 5xx response", async () => {
    mockFetchOnce("", 503);
    const adapter = new IemAsosWeatherAdapter();

    const result = await adapter.getObservation({ icaoCode: "EGLL", atUtc: "2024-01-01T00:00:00.000Z" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });

  it("returns a typed upstream_error on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNRESET")),
    );
    const adapter = new IemAsosWeatherAdapter();

    const result = await adapter.getObservation({ icaoCode: "EGLL", atUtc: "2024-01-01T00:00:00.000Z" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("upstream_error");
    }
  });
});

/**
 * Dev/ops tool. Bulk-imports real IATA airport reference data into the
 * `airports` Postgres table (src/db/schema.ts) — the data source behind
 * src/providers/airport-reference/, which replaced the two ~33-entry
 * hardcoded starter tables that used to live in src/domain/ec261/ (a gap that
 * caused a genuinely eligible claim — Ryanair FR725, MAD->PMO — to silently
 * fail because Palermo wasn't in either table).
 *
 * Source: OurAirports (https://ourairports.com/data/airports.csv, redirects
 * to its canonical GitHub Pages mirror) — public domain (CC0), community
 * maintained, actively updated. Filtered to scheduled_service === "yes": this
 * single filter is deliberate, not incidental — verified against a live fetch
 * (2026-08-11) that among scheduled-service rows, IATA codes are unique
 * (zero duplicates across ~4,160 rows). WITHOUT that filter, small
 * unlisted/private airstrips in the full ~86k-row dataset can carry a
 * duplicate/bogus iata_code value (e.g. a small Colombian airstrip and a
 * small Argentine airstrip both happened to carry "PMO"/"MAD" as their
 * iata_code, despite those being Palermo's and Madrid's real IATA codes).
 * Since "has scheduled commercial service" is also exactly the EC261-relevant
 * filter (this project only ever cares about airports passengers fly
 * scheduled flights from), it's the right filter for this project's purposes
 * too, not just a data-cleaning convenience.
 *
 * Rows missing an icao_code are skipped rather than stored with an empty
 * string: src/providers/weather/ needs a real ICAO station code, and a
 * scheduled-service airport with no ICAO in this dataset is itself a sign of
 * incomplete source data, not something to paper over.
 *
 * Rerunnable — every row is an upsert (AirportRepo.bulkUpsert), so running
 * this again just refreshes the data with whatever OurAirports has now.
 *
 * Usage: npx tsx scripts/import-airports.ts   (or: npm run airports:import)
 */
import { AirportRepo, type AirportRow } from "../src/db/repositories/airport.repo.js";
import { assertDatabaseConfigured } from "../src/db/client.js";

const OURAIRPORTS_CSV_URL = "https://ourairports.com/data/airports.csv";

/**
 * Minimal RFC4180 CSV parser — handles quoted fields containing commas,
 * embedded newlines, and escaped ("") quotes, which several airport names in
 * this dataset actually use (e.g. "Bristol, Filton Airport"). Splitting the
 * raw text on "\n" first, before handling quotes, would silently corrupt
 * those rows instead of erroring — worth a real parser, not a shortcut.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

interface ParseResult {
  rows: AirportRow[];
  skippedMissingIcao: number;
  skippedInvalid: number;
}

function toAirportRows(csvRows: string[][]): ParseResult {
  const header = csvRows[0];
  if (!header) {
    throw new Error("OurAirports CSV had no header row");
  }
  const col = (name: string): number => {
    const idx = header.indexOf(name);
    if (idx === -1) {
      throw new Error(
        `OurAirports CSV is missing expected column "${name}" — its schema may have changed; ` +
          "re-check this script's column mapping before trusting the import.",
      );
    }
    return idx;
  };

  const idxScheduled = col("scheduled_service");
  const idxIata = col("iata_code");
  const idxIcao = col("icao_code");
  const idxName = col("name");
  const idxCountry = col("iso_country");
  const idxLat = col("latitude_deg");
  const idxLon = col("longitude_deg");

  const rows: AirportRow[] = [];
  let skippedMissingIcao = 0;
  let skippedInvalid = 0;

  for (const csvRow of csvRows.slice(1)) {
    if (csvRow.length <= 1) continue; // trailing blank line

    if (csvRow[idxScheduled] !== "yes") continue;

    const iataCode = csvRow[idxIata]?.trim().toUpperCase();
    if (!iataCode || !/^[A-Z]{3}$/.test(iataCode)) {
      continue;
    }

    const icaoCode = csvRow[idxIcao]?.trim().toUpperCase();
    if (!icaoCode) {
      skippedMissingIcao++;
      continue;
    }

    const name = csvRow[idxName]?.trim();
    const countryIsoCode = csvRow[idxCountry]?.trim().toUpperCase();
    const latitude = Number(csvRow[idxLat]);
    const longitude = Number(csvRow[idxLon]);

    if (
      !name ||
      !countryIsoCode ||
      !/^[A-Z]{2}$/.test(countryIsoCode) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      skippedInvalid++;
      continue;
    }

    rows.push({ iataCode, icaoCode, name, countryIsoCode, latitude, longitude, source: "ourairports" });
  }

  return { rows, skippedMissingIcao, skippedInvalid };
}

async function main() {
  assertDatabaseConfigured();

  console.log(`Fetching ${OURAIRPORTS_CSV_URL}...`);
  const response = await fetch(OURAIRPORTS_CSV_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch OurAirports CSV: HTTP ${response.status}`);
  }
  const csvText = await response.text();

  console.log("Parsing CSV...");
  const csvRows = parseCsv(csvText);
  const { rows, skippedMissingIcao, skippedInvalid } = toAirportRows(csvRows);

  // scheduled_service=yes implying a unique iata_code was verified against a
  // live fetch during development, not assumed — but re-check it every run
  // rather than trusting that to hold forever against a dataset this project
  // doesn't control. A wrong airport silently overwriting a right one here is
  // exactly the kind of thing that should stop the import, not fix itself.
  const iataCodes = new Set(rows.map((r) => r.iataCode));
  if (iataCodes.size !== rows.length) {
    throw new Error(
      `OurAirports data produced ${rows.length - iataCodes.size} duplicate IATA code(s) after filtering to ` +
        "scheduled_service=yes — this script's dedup assumption no longer holds; stopping rather than silently " +
        "upserting whichever duplicate happened to be read last.",
    );
  }

  console.log(
    `Parsed ${rows.length} scheduled-service airports with a real IATA+ICAO code ` +
      `(skipped ${skippedMissingIcao} missing an ICAO code, ${skippedInvalid} with other malformed fields).`,
  );

  console.log("Upserting into the airports table...");
  await new AirportRepo().bulkUpsert(rows);

  console.log(`Done. ${rows.length} airports imported/refreshed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

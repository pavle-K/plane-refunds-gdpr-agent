import { eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { airports } from "../schema.js";

export interface AirportRow {
  iataCode: string;
  icaoCode: string;
  name: string;
  countryIsoCode: string;
  latitude: number;
  longitude: number;
  source: string;
}

// Postgres binds parameters per statement (limit 65535); each airport row has
// 7 columns, so this stays comfortably under that in one batch while keeping
// a bulk import (scripts/import-airports.ts, ~8-9k rows) to a small number of
// round trips instead of one per row.
const BULK_UPSERT_CHUNK_SIZE = 2000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Geographic reference data behind src/providers/airport-reference/ — see
 * schema.ts's airports table doc comment for why this holds only sourced
 * geographic facts (never an EU-membership legal judgment). */
export class AirportRepo {
  async findByIata(iataCode: string): Promise<AirportRow | null> {
    const rows = await db
      .select()
      .from(airports)
      .where(eq(airports.iataCode, iataCode.toUpperCase()))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Inserts or refreshes a single row — used by the self-healing fallback
   * (db.adapter.ts) the moment it resolves a code the bulk import missed. */
  async upsert(row: AirportRow): Promise<void> {
    await db
      .insert(airports)
      .values({ ...row, iataCode: row.iataCode.toUpperCase() })
      .onConflictDoUpdate({
        target: [airports.iataCode],
        set: {
          icaoCode: row.icaoCode,
          name: row.name,
          countryIsoCode: row.countryIsoCode,
          latitude: row.latitude,
          longitude: row.longitude,
          source: row.source,
          updatedAtUtc: sql`now()`,
        },
      });
  }

  /** Bulk insert/refresh for the OurAirports import (scripts/import-airports.ts)
   * — chunked internally so the caller doesn't have to think about Postgres's
   * per-statement parameter limit. Rerunning the import is safe: existing rows
   * are refreshed in place via the same onConflictDoUpdate as upsert(). */
  async bulkUpsert(rows: AirportRow[]): Promise<void> {
    for (const batch of chunk(rows, BULK_UPSERT_CHUNK_SIZE)) {
      await db
        .insert(airports)
        .values(batch.map((row) => ({ ...row, iataCode: row.iataCode.toUpperCase() })))
        .onConflictDoUpdate({
          target: [airports.iataCode],
          set: {
            icaoCode: sql`excluded.icao_code`,
            name: sql`excluded.name`,
            countryIsoCode: sql`excluded.country_iso_code`,
            latitude: sql`excluded.latitude`,
            longitude: sql`excluded.longitude`,
            source: sql`excluded.source`,
            updatedAtUtc: sql`now()`,
          },
        });
    }
  }
}

/**
 * Dev/test-only. Auto-discovers a small, varied set of real flights via
 * AeroAPI — one eligible, one real-but-not-eligible, one with no disruption
 * at all — so generate-test-emails.ts doesn't require you to already know
 * specific flights, and so a single run exercises more than the happy path.
 *
 * Deliberately two-step: this file's own /airports/{id}/flights/arrivals
 * call is UNVERIFIED against a live response (unlike
 * src/providers/flight-status/aeroapi.adapter.ts's /flights/{ident}, which
 * is hand-confirmed field-by-field against a real call). It's used ONLY to
 * harvest candidate (flight number, date) pairs. Every candidate is then
 * re-fetched through the already-verified AeroApiFlightStatusAdapter before
 * being trusted — a schema surprise here just means a skipped candidate,
 * never bad data downstream. If this endpoint's shape turns out to be wrong
 * on a live run, candidates.length silently stays 0 for that airport rather
 * than crashing; run with a wider --lookback-days or a different --airport
 * if search finds nothing.
 */
import type { AeroApiFlightStatusAdapter } from "../../src/providers/flight-status/aeroapi.adapter.js";
import type { FlightStatusResult } from "../../src/providers/flight-status/flight-status.port.js";
import { checkEligibility } from "../../src/domain/ec261/eligibility.js";
import { getAirportReference } from "../../src/domain/ec261/airport-reference.js";
import { createAirlineDirectoryProvider } from "../../src/providers/airline-directory/index.js";

const BASE_URL = "https://aeroapi.flightaware.com/aeroapi";

// Busy EU airports likely to have SOME real disruption in any given week —
// enough spread that the search doesn't come up empty.
export const DEFAULT_CANDIDATE_AIRPORTS = ["LHR", "CDG", "FRA", "AMS", "MAD", "FCO", "DUB", "MUC"];

interface AeroApiArrivalsResponse {
  arrivals?: Array<{
    ident_iata?: string | null;
    scheduled_out?: string | null;
  }>;
}

async function fetchCandidateIdentsForAirport(
  apiKey: string,
  airportIata: string,
  lookbackDays: number,
): Promise<Array<{ flightNumber: string; scheduledDepartureDateUtc: string }>> {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  // The verified /flights/{ident} endpoint (aeroapi.adapter.ts) takes plain
  // YYYY-MM-DD, not a full ISO-8601 timestamp — matching that format here too.
  const url = new URL(`${BASE_URL}/airports/${encodeURIComponent(airportIata)}/flights/arrivals`);
  url.searchParams.set("start", start.toISOString().slice(0, 10));
  url.searchParams.set("end", end.toISOString().slice(0, 10));
  url.searchParams.set("max_pages", "1");

  let response: Response;
  try {
    response = await fetch(url, { headers: { "x-apikey": apiKey } });
  } catch (cause) {
    console.warn(`  [${airportIata}] network error, skipping: ${String(cause)}`);
    return [];
  }

  if (!response.ok) {
    const bodyText = await response.text();
    console.warn(`  [${airportIata}] arrivals lookup returned HTTP ${response.status}: ${bodyText}`);
    return [];
  }

  let body: AeroApiArrivalsResponse;
  try {
    body = (await response.json()) as AeroApiArrivalsResponse;
  } catch {
    console.warn(`  [${airportIata}] malformed arrivals response, skipping this airport.`);
    return [];
  }

  const candidates: Array<{ flightNumber: string; scheduledDepartureDateUtc: string }> = [];
  for (const arrival of body.arrivals ?? []) {
    if (!arrival.ident_iata || !arrival.scheduled_out) continue;
    candidates.push({
      flightNumber: arrival.ident_iata,
      scheduledDepartureDateUtc: arrival.scheduled_out.slice(0, 10),
    });
  }
  return candidates;
}

/**
 * Runs the real flight/airline/route facts through the app's OWN
 * domain/ec261/eligibility.ts — the same function check-eligibility.node.ts
 * calls — so this reports exactly what the live pipeline would decide, not
 * an approximation. Used both by the auto-search below and by
 * generate-test-emails.ts's manual --flight/--date path.
 *
 * Cancellations are deliberately never reported eligible here: AeroAPI never
 * reports cancellationNoticeDays (see aeroapi.adapter.ts), and without it
 * checkEligibility can't determine cancellation eligibility either — same
 * "needs manual review" outcome the real node produces for a cancellation
 * with an unknown notice period.
 */
export async function describeRealEligibility(
  flight: FlightStatusResult,
  airlineDirectory: ReturnType<typeof createAirlineDirectoryProvider>,
): Promise<{ eligible: boolean; reason: string }> {
  if (flight.status === "cancelled") {
    return {
      eligible: false,
      reason: "cancelled, but AeroAPI doesn't report the cancellation notice period — needs manual review, same as the live pipeline.",
    };
  }
  if (flight.status !== "delayed" || flight.delayMinutesAtArrival === null) {
    return { eligible: false, reason: `status is "${flight.status}" — no compensable disruption at arrival.` };
  }

  let departureCountryIsEU: boolean;
  let arrivalCountryIsEU: boolean;
  try {
    departureCountryIsEU = getAirportReference(flight.departureAirportIata).countryIsEu;
    arrivalCountryIsEU = getAirportReference(flight.arrivalAirportIata).countryIsEu;
  } catch {
    return { eligible: false, reason: "unknown airport in airport-reference.ts" };
  }

  const airlineResult = await airlineDirectory.getAirline(flight.operatingCarrierIataCode);
  const operatingCarrierIsEU = airlineResult.ok ? airlineResult.value.isEuCarrier : false;

  const result = checkEligibility({
    disruptionType: "delay",
    delayMinutesAtArrival: flight.delayMinutesAtArrival,
    departureCountryIsEU,
    arrivalCountryIsEU,
    operatingCarrierIsEU,
  });

  return { eligible: result.eligible, reason: result.reason };
}

export type TestFlightCase = "eligible" | "ineligible" | "no_disruption" | "cancelled";

export const DEFAULT_TARGET_CASES: TestFlightCase[] = ["eligible", "ineligible", "no_disruption"];

export interface TestFlightCaseResult {
  testCase: TestFlightCase;
  flight: FlightStatusResult;
  eligibility: { eligible: boolean; reason: string };
}

function classifyCase(flight: FlightStatusResult, eligibility: { eligible: boolean }): TestFlightCase {
  if (flight.status === "cancelled") return "cancelled";
  if (flight.status === "delayed") return eligibility.eligible ? "eligible" : "ineligible";
  return "no_disruption";
}

/**
 * Collects one real, verified flight per requested test case (default:
 * eligible / ineligible / no_disruption) — a mix, not a single "best" match.
 * A real disrupted flight isn't automatically a useful test case on its own
 * (e.g. JFK->LHR is a real 3h+ delay but not EC261-eligible at all — the UK
 * isn't in the EU post-Brexit), so every candidate is classified by the same
 * real domain eligibility check the live pipeline uses, not by delay alone.
 *
 * Bounded by maxLookups (a getFlightStatus call per candidate) — AeroAPI's
 * per-account quota is easy to exhaust by scanning many airports/candidates,
 * so this stops as soon as either every target case is filled or the lookup
 * budget runs out, and returns whatever was found rather than requiring a
 * complete set.
 */
export async function findTestFlightSet(
  flightStatus: AeroApiFlightStatusAdapter,
  apiKey: string,
  opts: {
    airports?: string[];
    lookbackDays?: number;
    targetCases?: TestFlightCase[];
    maxLookups?: number;
  } = {},
): Promise<TestFlightCaseResult[]> {
  const airports = opts.airports ?? DEFAULT_CANDIDATE_AIRPORTS;
  const lookbackDays = opts.lookbackDays ?? 7;
  const targetCases = opts.targetCases ?? DEFAULT_TARGET_CASES;
  const maxLookups = opts.maxLookups ?? 40;
  const airlineDirectory = createAirlineDirectoryProvider();

  const remaining = new Set(targetCases);
  const results: TestFlightCaseResult[] = [];
  let lookupsUsed = 0;

  for (const airport of airports) {
    if (remaining.size === 0) break;

    console.log(`Searching ${airport} arrivals for: ${[...remaining].join(", ")}...`);
    const candidates = await fetchCandidateIdentsForAirport(apiKey, airport, lookbackDays);

    for (const candidate of candidates) {
      if (remaining.size === 0) break;
      if (lookupsUsed >= maxLookups) {
        console.warn(`  Hit the ${maxLookups}-lookup budget before filling every case — stopping search early.`);
        break;
      }

      lookupsUsed++;
      const result = await flightStatus.getFlightStatus(candidate);
      if (!result.ok) continue;

      const flight = result.value;
      const eligibility = await describeRealEligibility(flight, airlineDirectory);
      const testCase = classifyCase(flight, eligibility);

      if (remaining.has(testCase)) {
        console.log(
          `  [${testCase}] ${flight.flightNumber} on ${candidate.scheduledDepartureDateUtc} — ${eligibility.reason}`,
        );
        results.push({ testCase, flight, eligibility });
        remaining.delete(testCase);
      }
    }

    if (lookupsUsed >= maxLookups) break;
  }

  if (remaining.size > 0) {
    console.warn(`Could not find a real example of: ${[...remaining].join(", ")} within the search budget.`);
  }

  return results;
}

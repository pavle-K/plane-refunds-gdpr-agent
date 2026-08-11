/**
 * Dev/test-only. Auto-discovers a small, varied set of real flights via
 * AeroAPI — one eligible, one real-but-not-eligible, one with no disruption
 * at all — so generate-test-emails.ts doesn't require you to already know
 * specific flights, and so a single run exercises more than the happy path.
 *
 * Request-volume design (this replaced an earlier version that made one
 * getFlightStatus call PER CANDIDATE and reliably got rate-limited even with
 * pacing/backoff): the /airports/{id}/flights/{arrivals,departures} board
 * endpoint returns the same AeroApiFlight object shape as the hand-verified
 * /flights/{ident} endpoint (aeroapi.adapter.ts) — same field names
 * (ident_iata, scheduled_in/actual_in, cancelled, origin/destination, ...).
 * So classification is done directly from that ONE board response via the
 * SAME exported toFlightStatusResult() mapping, with zero extra requests per
 * candidate scanned. The board endpoint's shape is still unverified against
 * a live call (unlike /flights/{ident}), so as a final safety net, whichever
 * 2-3 candidates actually fill a target case get ONE confirmatory
 * getFlightStatus call each through the verified endpoint before being
 * trusted — this script never sends an email built from unconfirmed data,
 * it just stops re-confirming every candidate it merely LOOKS at.
 *
 * Rate-limit handling: requests are paced (a minimum gap between calls) and
 * a 429 retries that same request after a fixed cooldown rather than
 * abandoning the whole search. Kept local to this dev script, not the shared
 * production AeroApiFlightStatusAdapter.
 */
import { AeroApiFlightStatusAdapter, toFlightStatusResult, type AeroApiFlight } from "../../src/providers/flight-status/aeroapi.adapter.js";
import type { FlightStatusResult, FlightStatusQuery, FlightStatusError } from "../../src/providers/flight-status/flight-status.port.js";
import type { Result } from "../../src/lib/result.js";
import { checkEligibility } from "../../src/domain/ec261/eligibility.js";
import { isEuMemberCountry } from "../../src/domain/ec261/eu-membership.js";
import { createAirlineDirectoryProvider } from "../../src/providers/airline-directory/index.js";
import { createAirportReferenceProvider, type AirportReferenceProvider } from "../../src/providers/airport-reference/index.js";

const BASE_URL = "https://aeroapi.flightaware.com/aeroapi";

// Minimum gap between any two AeroAPI requests, and how a 429 is handled: a
// fixed cooldown retry rather than giving up immediately. AeroAPI's limit
// held for well over a minute of escalating backoff in practice, so this is
// a flat wait, not a short exponential ramp.
const REQUEST_PACING_MS = 1200;
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_COOLDOWN_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RequestPacer {
  private lastRequestAt = 0;

  async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < REQUEST_PACING_MS) {
      await sleep(REQUEST_PACING_MS - elapsed);
    }
    this.lastRequestAt = Date.now();
  }
}

// Busy EU airports likely to have SOME real disruption in any given week —
// enough spread that the search doesn't come up empty.
export const DEFAULT_CANDIDATE_AIRPORTS = ["LHR", "CDG", "FRA", "AMS", "MAD", "FCO", "DUB", "MUC"];

// The EU-member subset of the above (excludes LHR — UK, post-Brexit; see
// airport-reference.ts). Searched via DEPARTURES first: EC261 covers ANY
// flight departing an EU airport regardless of carrier, so a delayed flight
// found here is eligible by definition — no need to also get lucky on carrier
// nationality, unlike an arrivals-board search (see findTestFlightSet's doc).
const EU_DEPARTURE_AIRPORTS = ["CDG", "FRA", "AMS", "MAD", "FCO", "DUB", "MUC"];

type BoardType = "arrivals" | "departures";

interface AeroApiBoardResponse {
  arrivals?: AeroApiFlight[];
  departures?: AeroApiFlight[];
}

interface BoardFetchResult {
  flights: FlightStatusResult[];
  rateLimited: boolean;
}

/** One request per airport — every flight on the board is mapped locally via
 * the shared, hand-verified toFlightStatusResult(); nothing here makes a
 * second request per candidate. */
async function fetchBoard(
  apiKey: string,
  airportIata: string,
  lookbackDays: number,
  boardType: BoardType,
  pacer: RequestPacer,
): Promise<BoardFetchResult> {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  // The verified /flights/{ident} endpoint (aeroapi.adapter.ts) takes plain
  // YYYY-MM-DD, not a full ISO-8601 timestamp — matching that format here too.
  const url = new URL(`${BASE_URL}/airports/${encodeURIComponent(airportIata)}/flights/${boardType}`);
  url.searchParams.set("start", start.toISOString().slice(0, 10));
  url.searchParams.set("end", end.toISOString().slice(0, 10));
  url.searchParams.set("max_pages", "1");

  const label = `${airportIata} ${boardType}`;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    await pacer.throttle();

    let response: Response;
    try {
      response = await fetch(url, { headers: { "x-apikey": apiKey } });
    } catch (cause) {
      console.warn(`  [${label}] network error, skipping: ${String(cause)}`);
      return { flights: [], rateLimited: false };
    }

    if (response.status === 429) {
      if (attempt < MAX_RATE_LIMIT_RETRIES) {
        console.warn(
          `  [${label}] rate-limited, cooling down ${RATE_LIMIT_COOLDOWN_MS / 1000}s (retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})...`,
        );
        await sleep(RATE_LIMIT_COOLDOWN_MS);
        continue;
      }
      console.warn(`  [${label}] still rate-limited after ${MAX_RATE_LIMIT_RETRIES} retries — giving up on this airport.`);
      return { flights: [], rateLimited: true };
    }

    if (!response.ok) {
      const bodyText = await response.text();
      console.warn(`  [${label}] lookup returned HTTP ${response.status}: ${bodyText}`);
      return { flights: [], rateLimited: false };
    }

    let body: AeroApiBoardResponse;
    try {
      body = (await response.json()) as AeroApiBoardResponse;
    } catch {
      console.warn(`  [${label}] malformed response, skipping this airport.`);
      return { flights: [], rateLimited: false };
    }

    const entries = (boardType === "arrivals" ? body.arrivals : body.departures) ?? [];
    const flights: FlightStatusResult[] = [];
    for (const entry of entries) {
      if (!entry.ident_iata) continue;
      const mapped = toFlightStatusResult(entry.ident_iata, entry);
      if (mapped) flights.push(mapped);
    }
    return { flights, rateLimited: false };
  }

  // Unreachable: the loop always returns on success, a non-429 response, or
  // exhausting retries — this satisfies TS's control-flow analysis only.
  return { flights: [], rateLimited: true };
}

async function confirmWithRetry(
  flightStatus: AeroApiFlightStatusAdapter,
  candidate: FlightStatusQuery,
  pacer: RequestPacer,
): Promise<Result<FlightStatusResult, FlightStatusError>> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    await pacer.throttle();
    const result = await flightStatus.getFlightStatus(candidate);
    if (result.ok || result.error.type !== "rate_limited") {
      return result;
    }
    if (attempt < MAX_RATE_LIMIT_RETRIES) {
      console.warn(
        `  [${candidate.flightNumber}] rate-limited confirming, cooling down ${RATE_LIMIT_COOLDOWN_MS / 1000}s (retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})...`,
      );
      await sleep(RATE_LIMIT_COOLDOWN_MS);
      continue;
    }
    console.warn(`  [${candidate.flightNumber}] still rate-limited after ${MAX_RATE_LIMIT_RETRIES} retries.`);
    return result;
  }
  // Unreachable, same reasoning as fetchBoard above.
  return await flightStatus.getFlightStatus(candidate);
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
  airportReference: AirportReferenceProvider,
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

  // Matches check-eligibility.node.ts exactly: a failure on EITHER lookup
  // falls through as non-EU for just that one side — not both. A departure
  // lookup that already succeeded (e.g. a real EU airport) must still count
  // even if the arrival airport is missing from the airports table;
  // discarding it would wrongly report "not eligible" for a flight that's
  // eligible purely on departure alone (Article 3(1)(a) doesn't care about
  // the arrival airport or carrier at all).
  const [departureAirportResult, arrivalAirportResult] = await Promise.all([
    airportReference.getAirport(flight.departureAirportIata),
    airportReference.getAirport(flight.arrivalAirportIata),
  ]);
  const departureCountryIsEU = departureAirportResult.ok && isEuMemberCountry(departureAirportResult.value.countryIsoCode);
  const arrivalCountryIsEU = arrivalAirportResult.ok && isEuMemberCountry(arrivalAirportResult.value.countryIsoCode);

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

interface SearchState {
  remaining: Set<TestFlightCase>;
  results: TestFlightCaseResult[];
  rateLimited: boolean;
}

async function searchOneBoard(
  flightStatus: AeroApiFlightStatusAdapter,
  apiKey: string,
  airport: string,
  boardType: BoardType,
  lookbackDays: number,
  airlineDirectory: ReturnType<typeof createAirlineDirectoryProvider>,
  airportReference: AirportReferenceProvider,
  pacer: RequestPacer,
  state: SearchState,
): Promise<void> {
  console.log(`Searching ${airport} ${boardType} for: ${[...state.remaining].join(", ")}...`);
  const { flights, rateLimited } = await fetchBoard(apiKey, airport, lookbackDays, boardType, pacer);
  if (rateLimited) {
    state.rateLimited = true;
    return;
  }

  for (const boardFlight of flights) {
    if (state.remaining.size === 0) return;

    // Classified directly from the board data — no request spent yet.
    const eligibility = await describeRealEligibility(boardFlight, airlineDirectory, airportReference);
    const testCase = classifyCase(boardFlight, eligibility);
    if (!state.remaining.has(testCase)) continue;

    // This candidate fills a still-needed case — confirm it through the
    // hand-verified endpoint before trusting it enough to email.
    const confirmed = await confirmWithRetry(
      flightStatus,
      { flightNumber: boardFlight.flightNumber, scheduledDepartureDateUtc: boardFlight.scheduledDepartureUtc.slice(0, 10) },
      pacer,
    );
    if (!confirmed.ok) {
      if (confirmed.error.type === "rate_limited") {
        state.rateLimited = true;
        return;
      }
      continue; // confirmation disagreed or failed — skip, don't trust the board alone
    }

    const confirmedFlight = confirmed.value;
    const confirmedEligibility = await describeRealEligibility(confirmedFlight, airlineDirectory, airportReference);
    const confirmedCase = classifyCase(confirmedFlight, confirmedEligibility);
    if (!state.remaining.has(confirmedCase)) continue; // confirmation disagreed with the board — skip

    console.log(
      `  [${confirmedCase}] ${confirmedFlight.flightNumber} on ${boardFlight.scheduledDepartureUtc.slice(0, 10)} — ${confirmedEligibility.reason}`,
    );
    state.results.push({ testCase: confirmedCase, flight: confirmedFlight, eligibility: confirmedEligibility });
    state.remaining.delete(confirmedCase);
  }
}

/**
 * Collects one real, verified flight per requested test case (default:
 * eligible / ineligible / no_disruption) — a mix, not a single "best" match.
 * A real disrupted flight isn't automatically a useful test case on its own
 * (e.g. JFK->LHR is a real 3h+ delay but not EC261-eligible at all — the UK
 * isn't in the EU post-Brexit), so every candidate is classified by the same
 * real domain eligibility check the live pipeline uses, not by delay alone.
 *
 * Searches EU-airport DEPARTURES first, not just arrivals: EC261 covers any
 * flight departing an EU airport regardless of carrier, so that's a much
 * higher-yield source for the "eligible" case than arrivals (which also
 * needs the operating carrier to happen to be an EU carrier — arrivals at a
 * major hub are dominated by foreign carriers, so that bucket was reliably
 * coming up empty before this was added). Arrivals search (including LHR,
 * a non-EU airport) still runs afterward for remaining cases/variety.
 */
export async function findTestFlightSet(
  flightStatus: AeroApiFlightStatusAdapter,
  apiKey: string,
  opts: {
    airports?: string[];
    lookbackDays?: number;
    targetCases?: TestFlightCase[];
  } = {},
): Promise<TestFlightCaseResult[]> {
  const lookbackDays = opts.lookbackDays ?? 7;
  const airlineDirectory = createAirlineDirectoryProvider();
  const airportReference = createAirportReferenceProvider();
  const pacer = new RequestPacer();

  const state: SearchState = {
    remaining: new Set(opts.targetCases ?? DEFAULT_TARGET_CASES),
    results: [],
    rateLimited: false,
  };

  // Only run the EU-departures pre-pass against the default airport set — an
  // explicit --airport override means the caller wants that specific
  // airport's arrivals searched, matching the documented CLI behavior.
  if (!opts.airports) {
    for (const airport of EU_DEPARTURE_AIRPORTS) {
      if (state.remaining.size === 0 || state.rateLimited) break;
      await searchOneBoard(flightStatus, apiKey, airport, "departures", lookbackDays, airlineDirectory, airportReference, pacer, state);
    }
  }

  const arrivalAirports = opts.airports ?? DEFAULT_CANDIDATE_AIRPORTS;
  for (const airport of arrivalAirports) {
    if (state.remaining.size === 0 || state.rateLimited) break;
    await searchOneBoard(flightStatus, apiKey, airport, "arrivals", lookbackDays, airlineDirectory, airportReference, pacer, state);
  }

  if (state.remaining.size > 0) {
    const reason = state.rateLimited ? "still rate-limited even after retries" : "no matching candidates found";
    console.warn(`Could not find a real example of: ${[...state.remaining].join(", ")} (${reason}). Try again later.`);
  }

  return state.results;
}

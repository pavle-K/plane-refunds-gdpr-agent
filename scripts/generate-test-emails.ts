/**
 * Dev/test-only tool. NOT part of the app — nothing under src/ imports this,
 * and it never runs in production.
 *
 * Problem it solves: testing scan_inbox/booking-extraction end to end needs
 * real booking-confirmation emails in a real inbox, but you can't manufacture
 * a fake "real" flight — AeroAPI's `start` bound on this plan tier rejects
 * anything more than ~10 days in the past (see aeroapi.adapter.ts). So this
 * script doesn't invent flight data: by default it AUTO-SEARCHES (via
 * scripts/lib/find-real-flight.ts) for a small, VARIED set of real flights —
 * one genuinely EC261-eligible, one real-but-not-eligible (a real delay
 * doesn't automatically mean eligible: e.g. a US carrier flying JFK->LHR is a
 * real 3h+ delay but not covered at all, since the UK isn't in the EU
 * post-Brexit and Virgin Atlantic isn't an EU carrier), and one with no
 * disruption at all — and sends one email per case. Every case is classified
 * by the app's OWN domain/ec261/eligibility.ts, the same function
 * check-eligibility.node.ts calls, so it's testing against real decisions,
 * not a guess.
 *
 * Pass --flight/--date yourself for a single specific flight instead — the
 * same real eligibility check still runs and prints its result, it just
 * won't block sending.
 *
 * Sends over plain SMTP (not the Postmark email-send provider — that's wired
 * for outbound claim correspondence to airlines, not arbitrary test mail to
 * your own inbox). Needs an SMTP account distinct from app-level config, so
 * these vars are read directly here rather than added to src/config/env.ts's
 * schema, which validates config the running app depends on.
 *
 * Setup (Gmail example — any SMTP account works):
 *   1. Google Account → Security → 2-Step Verification → App passwords →
 *      generate one for "Mail".
 *   2. In .env:
 *        TEST_EMAIL_SMTP_HOST=smtp.gmail.com
 *        TEST_EMAIL_SMTP_PORT=465
 *        TEST_EMAIL_SMTP_USER=you@gmail.com
 *        TEST_EMAIL_SMTP_PASS=<app password, not your account password>
 *
 * Usage (fully automatic — finds eligible/ineligible/no-disruption examples and mails yourself):
 *   npx tsx scripts/generate-test-emails.ts
 *
 * Usage (a specific known flight, or a non-default recipient/airport):
 *   npx tsx scripts/generate-test-emails.ts \
 *     [--flight BA123 --date 2026-08-03] [--to you@gmail.com] \
 *     [--airport LHR] [--lookback-days 7] \
 *     [--passenger "Test Passenger"] [--carrier "British Airways"]
 */
import nodemailer, { type Transporter } from "nodemailer";
import { randomBytes } from "node:crypto";
import { env } from "../src/config/env.js";
import { AeroApiFlightStatusAdapter } from "../src/providers/flight-status/aeroapi.adapter.js";
import type { FlightStatusResult } from "../src/providers/flight-status/flight-status.port.js";
import {
  findTestFlightSet,
  describeRealEligibility,
  DEFAULT_TARGET_CASES,
  type TestFlightCase,
} from "./lib/find-real-flight.js";
import { createAirlineDirectoryProvider } from "../src/providers/airline-directory/index.js";
import { createAirportReferenceProvider } from "../src/providers/airport-reference/index.js";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

function requireSmtpEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name} in .env. This script sends over plain SMTP — see the ` +
        `file header for setup (an app password works fine for Gmail).`,
    );
  }
  return value;
}

const CASE_REFERENCE_PREFIX: Record<TestFlightCase, string> = {
  eligible: "ELIG",
  ineligible: "NELG",
  no_disruption: "NODI",
  cancelled: "CANC",
};

function randomBookingReference(prefix?: string): string {
  const suffix = randomBytes(2).toString("hex").toUpperCase();
  return prefix ? `${prefix}${suffix}` : randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

function buildEmailBody(params: {
  bookingReference: string;
  passengerName: string;
  flight: FlightStatusResult;
  carrierName: string | undefined;
}): { subject: string; bodyText: string } {
  const carrierLabel = params.carrierName ?? params.flight.operatingCarrierIataCode;
  return {
    subject: `Your booking confirmation - ${carrierLabel}`,
    bodyText:
      `Booking reference: ${params.bookingReference}\n` +
      `Passenger: ${params.passengerName}\n` +
      `Flight: ${params.flight.flightNumber}\n` +
      `Date: ${params.flight.scheduledDepartureUtc.slice(0, 10)}\n` +
      `From: ${params.flight.departureAirportIata} To: ${params.flight.arrivalAirportIata}\n\n` +
      `Thank you for booking with ${carrierLabel}.\n`,
  };
}

async function sendOneTestEmail(
  transport: Transporter,
  params: {
    smtpUser: string;
    to: string;
    passengerName: string;
    carrierName: string | undefined;
    flight: FlightStatusResult;
    eligibility: { eligible: boolean; reason: string };
    referencePrefix?: string;
  },
): Promise<void> {
  console.log(
    `\n[${params.flight.flightNumber}] ${params.flight.status}` +
      (params.flight.delayMinutesAtArrival !== null ? ` (${params.flight.delayMinutesAtArrival}min delay at arrival)` : "") +
      `\n  ${params.flight.departureAirportIata} -> ${params.flight.arrivalAirportIata}, scheduled arrival ${params.flight.scheduledArrivalUtc}` +
      (params.flight.actualArrivalUtc ? `, actual arrival ${params.flight.actualArrivalUtc}` : "") +
      `\n  Eligibility (per the app's own domain/ec261 rules): ${params.eligibility.eligible ? "ELIGIBLE" : "not eligible"} — ${params.eligibility.reason}`,
  );

  const bookingReference = randomBookingReference(params.referencePrefix);
  const { subject, bodyText } = buildEmailBody({
    bookingReference,
    passengerName: params.passengerName,
    flight: params.flight,
    carrierName: params.carrierName,
  });

  console.log(`  Sending to ${params.to} (booking reference ${bookingReference})...`);
  await transport.sendMail({ from: params.smtpUser, to: params.to, subject, text: bodyText });
}

async function main() {
  const passengerName = getArg("passenger") ?? "Test Passenger";
  const carrierName = getArg("carrier");
  const manualFlight = getArg("flight");
  const manualDate = getArg("date");

  if ((manualFlight && !manualDate) || (!manualFlight && manualDate)) {
    throw new Error("--flight and --date must be given together, or both omitted to auto-search.");
  }

  if (!env.FLIGHT_DATA_API_KEY) {
    throw new Error(
      "FLIGHT_DATA_API_KEY is not set. This script deliberately refuses to fabricate " +
        "flight data — it needs the real AeroAPI adapter so the generated email(s) match " +
        "what checkEligibility will actually see.",
    );
  }
  const flightStatusAdapter = new AeroApiFlightStatusAdapter(env.FLIGHT_DATA_API_KEY);

  const smtpUser = requireSmtpEnv("TEST_EMAIL_SMTP_USER");
  const to = getArg("to") ?? smtpUser;
  const transport = nodemailer.createTransport({
    host: requireSmtpEnv("TEST_EMAIL_SMTP_HOST"),
    port: Number(requireSmtpEnv("TEST_EMAIL_SMTP_PORT")),
    secure: Number(requireSmtpEnv("TEST_EMAIL_SMTP_PORT")) === 465,
    auth: { user: smtpUser, pass: requireSmtpEnv("TEST_EMAIL_SMTP_PASS") },
  });

  if (manualFlight && manualDate) {
    console.log(`Looking up real status for ${manualFlight} on ${manualDate} via AeroAPI...`);
    const result = await flightStatusAdapter.getFlightStatus({
      flightNumber: manualFlight,
      scheduledDepartureDateUtc: manualDate,
    });
    if (!result.ok) {
      console.error(`\nFAILED to fetch real flight status: [${result.error.type}] ${result.error.message}`);
      if (result.error.type === "not_found") {
        console.error(
          "\nIf this flight is more than ~10 days in the past, that's expected — AeroAPI's " +
            "lookback window on this plan tier rejects it. Omit --flight/--date to auto-search instead.",
        );
      }
      process.exit(1);
    }
    const flight = result.value;
    const eligibility = await describeRealEligibility(flight, createAirlineDirectoryProvider(), createAirportReferenceProvider());
    await sendOneTestEmail(transport, { smtpUser, to, passengerName, carrierName, flight, eligibility });
  } else {
    const airportArg = getArg("airport");
    const found = await findTestFlightSet(flightStatusAdapter, env.FLIGHT_DATA_API_KEY, {
      ...(airportArg ? { airports: [airportArg] } : {}),
      lookbackDays: Number(getArg("lookback-days") ?? "7"),
    });

    if (found.length === 0) {
      console.error(
        "\nFAILED to find any real flight in the searched airports/window.\n" +
          "Try a wider --lookback-days, a different --airport, " +
          "or pass a specific --flight/--date you already know about.",
      );
      process.exit(1);
    }

    for (const { testCase, flight, eligibility } of found) {
      await sendOneTestEmail(transport, {
        smtpUser,
        to,
        passengerName,
        carrierName,
        flight,
        eligibility,
        referencePrefix: CASE_REFERENCE_PREFIX[testCase],
      });
    }

    const foundCases = new Set(found.map((f) => f.testCase));
    const missing = DEFAULT_TARGET_CASES.filter((c) => !foundCases.has(c));
    if (missing.length > 0) {
      console.log(
        `\nNote: sent ${found.length} of ${DEFAULT_TARGET_CASES.length} target cases — missing: ${missing.join(", ")}. ` +
          "See the search warnings above for why (likely AeroAPI rate-limiting); re-run later to try to fill the rest.",
      );
    }
  }

  console.log("\nDone. Run `npm run email:check` or ask the operator to scan your inbox to pick these up.");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

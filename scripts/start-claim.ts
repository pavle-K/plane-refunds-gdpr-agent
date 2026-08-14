/**
 * Starts a claim through the pipeline. Each provider is wired from its
 * factory (src/providers/*\/index.ts, src/agent/llm/index.ts), which picks the
 * live adapter whenever its API key is set in .env and falls back otherwise.
 * Interactive: pauses for a human decision at the approval gate, printing the
 * drafted letter, exactly like production.
 *
 * Usage:
 *   npx tsx scripts/start-claim.ts --flight BA123 --date 2024-06-15 \
 *     --from LHR --to JFK --carrier BA [--ref ABC123] [--name "Jane Doe"] \
 *     [--delay 220] [--status delayed]
 *
 * --delay/--status/--from/--to/--carrier are only used to seed a flight-status
 * result if FLIGHT_DATA_API_KEY isn't set (no AeroAPI adapter to query) — with a
 * key set, the actual flight's status is looked up instead and these are
 * ignored for that purpose (still used to build the booking object).
 *
 * IMPORTANT: no carrier in src/providers/airline-directory/data/airlines.json
 * currently has an "email" submission method — every entry is web_form or
 * unsupported, deliberately, because nothing else has been sourced and verified
 * (see that file and airline-directory.port.ts). So even with a real
 * POSTMARK_API_KEY, approving here resolves to "needs_manual_submission" and
 * sends nothing; sendClaim is only reached once a carrier has a verified
 * claims email.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "../src/agent/graph.js";
import { setupCheckpointer, getCheckpointer } from "../src/agent/checkpointer.js";
import { createRealGraphDeps } from "../src/agent/real-deps.js";
import { FakeFlightStatusAdapter, buildOnTimeResult } from "../src/providers/flight-status/index.js";
import { FakeEmailSendAdapter } from "../src/providers/email-send/index.js";
import { FakeLlmClient } from "../src/agent/llm/index.js";
import { ok } from "../src/lib/result.js";
import { env } from "../src/config/env.js";
import type { Booking } from "../src/domain/claim/claim.types.js";
import type { FlightDisruptionStatus } from "../src/providers/flight-status/flight-status.port.js";

function getArg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  const value = idx !== -1 ? process.argv[idx + 1] : undefined;
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

async function promptApproval(rl: ReturnType<typeof createInterface>) {
  const answer = (await rl.question("\nApprove (a) / Edit (e) / Decline (d)? ")).trim().toLowerCase();
  if (answer === "d" || answer === "decline") {
    return { action: "decline" as const };
  }
  if (answer === "e" || answer === "edit") {
    const editedText = await rl.question("Enter the full edited claim text:\n> ");
    return { action: "edit" as const, editedText };
  }
  return { action: "approve" as const };
}

async function main() {
  const flightNumber = getArg("flight");
  const scheduledDepartureDateUtc = getArg("date");
  const departureAirportIata = getArg("from");
  const arrivalAirportIata = getArg("to");
  const carrierCode = getArg("carrier");
  const bookingReference = getArg("ref", `TEST-${Date.now()}`);
  const passengerFullName = getArg("name", "Test Passenger");
  const delayMinutes = Number(getArg("delay", "220"));
  const status = getArg("status", "delayed") as FlightDisruptionStatus;

  console.log("1. Setting up checkpointer against real Postgres...");
  await setupCheckpointer();

  const deps = createRealGraphDeps();
  const { flightStatus, llm, emailSend } = deps;

  if (flightStatus instanceof FakeFlightStatusAdapter) {
    console.log(`   FLIGHT_DATA_API_KEY not set — seeding a SYNTHETIC flight status (status=${status}, delay=${delayMinutes}m).`);
    flightStatus.seed(
      { flightNumber, scheduledDepartureDateUtc },
      ok(
        buildOnTimeResult({
          flightNumber,
          operatingCarrierIataCode: carrierCode,
          departureAirportIata,
          arrivalAirportIata,
          status,
          delayMinutesAtArrival: status === "delayed" ? delayMinutes : null,
        }),
      ),
    );
  } else {
    console.log("   Using REAL AeroAPI flight-status lookup.");
  }

  console.log(`   LLM: ${llm instanceof FakeLlmClient ? `FAKE (LLM_PROVIDER=${env.LLM_PROVIDER}, but its key/config isn't set)` : `REAL call via LLM_PROVIDER=${env.LLM_PROVIDER}`}`);
  if (llm instanceof FakeLlmClient) {
    console.log("   Queuing generic canned score/draft responses so the script can still run.");
    llm.enqueueJson({
      successLikelihood: 0.5,
      confidence: 0.3,
      reasoning: "Generic fallback score — no ANTHROPIC_API_KEY was set, so this isn't a real assessment.",
      citedEvidence: [],
    });
    llm.enqueueJson({
      letterText: `[GENERIC PLACEHOLDER — configure LLM_PROVIDER's key/config for a real draft]\n\nDear ${carrierCode},\n\nI am writing to claim EC261 compensation for flight ${flightNumber} on ${scheduledDepartureDateUtc}, booking reference ${bookingReference}.`,
    });
  }

  console.log(`   Email send: ${emailSend instanceof FakeEmailSendAdapter ? "FAKE — nothing will actually be emailed" : "REAL Postmark — approving WILL send a real email"}`);

  const booking: Booking = {
    bookingReference,
    passengers: [{ id: "passenger-1", fullName: passengerFullName, email: "" }],
    segments: [
      {
        flightNumber,
        operatingCarrierCode: carrierCode,
        departureAirportIata,
        arrivalAirportIata,
        scheduledDepartureUtc: `${scheduledDepartureDateUtc}T00:00:00.000Z`,
        scheduledArrivalUtc: `${scheduledDepartureDateUtc}T00:00:00.000Z`,
      },
    ],
  };

  const graph = buildGraph(deps);
  const threadId = `claim-${randomUUID()}`;
  const config = { configurable: { thread_id: threadId } };

  console.log(`\n2. Running ingest → eligibility → score → draft (thread: ${threadId})...`);
  const afterDraft = (await graph.invoke(
    { claimId: threadId, claimStatus: "draft", booking },
    config,
  )) as Record<string, unknown>;

  if (!afterDraft["__interrupt__"]) {
    console.log("\nGraph did not reach human-approval — final state:");
    console.log(JSON.stringify(afterDraft, null, 2));
    await getCheckpointer().end();
    return;
  }

  console.log("\n=== Eligibility ===");
  console.log("eligible:", afterDraft["eligible"], "—", afterDraft["eligibilityReason"]);
  console.log("compensationCents:", afterDraft["compensationCents"]);
  console.log("\n=== Score ===");
  console.log(JSON.stringify(afterDraft["score"], null, 2));
  console.log("\n=== Drafted claim letter ===\n");
  console.log(afterDraft["draftText"]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const decision = await promptApproval(rl);
  rl.close();

  const result = (await graph.invoke(new Command({ resume: decision }), config)) as Record<string, unknown>;

  if (result["claimStatus"] === "declined") {
    console.log("\nDeclined. Nothing was sent. Thread:", threadId);
    await getCheckpointer().end();
    return;
  }

  console.log("\nclaimStatus:", result["claimStatus"]);
  console.log("Sent emails so far:", emailSend instanceof FakeEmailSendAdapter ? emailSend.sentEmails : "(sent via real Postmark)");
  if (result["__interrupt__"]) {
    console.log("\nNow awaiting the airline's response.");
    console.log(`When you have a real reply, resume with:\n  npx tsx scripts/resume-claim.ts --thread ${threadId}`);
  }

  await getCheckpointer().end();
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

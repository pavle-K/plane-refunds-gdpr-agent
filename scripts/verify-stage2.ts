/**
 * Stage 2 deliverable check (CLAUDE.md): "full graph runs against real (or
 * sandboxed) data end-to-end for a single test claim, stopping correctly at the
 * human-approval gate and resuming correctly after approval."
 *
 * Uses the REAL Postgres checkpointer (proving durability, like Stage 0) but
 * sandboxed/fake providers and LLM — we don't have live AeroAPI/Anthropic/Postmark
 * keys yet. Not part of the automated test suite; run with: npm run verify:stage2
 */
import { Command } from "@langchain/langgraph";
import { buildGraph } from "../src/agent/graph.js";
import { setupCheckpointer, getCheckpointer } from "../src/agent/checkpointer.js";
import { FakeFlightStatusAdapter, buildOnTimeResult } from "../src/providers/flight-status/fake.adapter.js";
import { FakeWeatherAdapter, buildClearSkyObservation } from "../src/providers/weather/fake.adapter.js";
import { FakeDisruptionAdapter } from "../src/providers/disruption/fake.adapter.js";
import { StaticAirlineDirectoryAdapter } from "../src/providers/airline-directory/static.adapter.js";
import { FakeAirportReferenceAdapter, buildAirportFacts } from "../src/providers/airport-reference/fake.adapter.js";
import { FakeEmailSendAdapter } from "../src/providers/email-send/fake.adapter.js";
import { FakePaymentsAdapter } from "../src/providers/payments/fake.adapter.js";
import { FakeLlmClient } from "../src/agent/llm/fake.adapter.js";
import { DbAuditLog } from "../src/compliance/audit-log.js";
import { ok } from "../src/lib/result.js";
import type { Booking } from "../src/domain/claim/claim.types.js";

const BOOKING: Booking = {
  bookingReference: "STAGE2-VERIFY",
  passengers: [{ id: "p1", fullName: "Jane Doe", email: "jane@example.com" }],
  segments: [
    {
      flightNumber: "LH456",
      operatingCarrierCode: "LH",
      scheduledDepartureUtc: "2024-06-15T09:00:00.000Z",
      scheduledArrivalUtc: "2024-06-15T18:00:00.000Z",
    },
  ],
};

const FLIGHT_QUERY = { flightNumber: "LH456", scheduledDepartureDateUtc: "2024-06-15" };

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  console.log("1. Setting up checkpointer against real Postgres...");
  await setupCheckpointer();

  const flightStatus = new FakeFlightStatusAdapter();
  flightStatus.seed(
    FLIGHT_QUERY,
    ok(
      buildOnTimeResult({
        flightNumber: "LH456",
        operatingCarrierIataCode: "LH",
        departureAirportIata: "FRA",
        arrivalAirportIata: "SIN",
        status: "delayed",
        delayMinutesAtArrival: 220,
      }),
    ),
  );

  const weather = new FakeWeatherAdapter();
  weather.seed(
    { icaoCode: "EDDF", atUtc: "2024-06-15T09:00:00.000Z" },
    ok(buildClearSkyObservation({ icaoCode: "EDDF" })),
  );

  const llm = new FakeLlmClient();
  llm.enqueueJson({
    successLikelihood: 0.8,
    confidence: 0.7,
    reasoning: "Clear weather rules out an extraordinary-circumstances defence.",
    citedEvidence: ["METAR showed clear skies at departure"],
  });
  llm.enqueueJson({ letterText: "Dear Lufthansa, I am writing to claim EC261 compensation of €600..." });
  llm.enqueueJson({ category: "accepted", reasoning: "Airline agreed to pay.", requestedInfo: null });

  const emailSend = new FakeEmailSendAdapter();
  const payments = new FakePaymentsAdapter();

  const airportReference = new FakeAirportReferenceAdapter();
  airportReference.seed(
    "FRA",
    ok(buildAirportFacts({ iataCode: "FRA", icaoCode: "EDDF", name: "Frankfurt", countryIsoCode: "DE", latitude: 50.0379, longitude: 8.5622 })),
  );
  airportReference.seed(
    "SIN",
    ok(buildAirportFacts({ iataCode: "SIN", icaoCode: "WSSS", name: "Singapore Changi", countryIsoCode: "SG", latitude: 1.3644, longitude: 103.9915 })),
  );

  const deps = {
    extractor: async () => null, // unused — booking supplied directly, ingest short-circuits
    flightStatus,
    weather,
    disruption: new FakeDisruptionAdapter(),
    airlineDirectory: new StaticAirlineDirectoryAdapter(),
    airportReference,
    emailSend,
    payments,
    llm,
    auditLog: new DbAuditLog(),
  };

  const graph = buildGraph(deps);
  const threadId = `stage2-verify-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  section("2. First run: ingest → eligibility → score → draft → INTERRUPT at approval");
  const afterDraft = (await graph.invoke(
    { claimId: threadId, claimStatus: "draft", booking: BOOKING },
    config,
  )) as Record<string, unknown>;

  if (!afterDraft["__interrupt__"]) {
    throw new Error("FAILED: expected the graph to interrupt at human-approval, but it did not");
  }
  console.log("   Interrupted as expected. Draft text present:", Boolean(afterDraft["draftText"]));
  console.log("   No email sent yet:", emailSend.sentEmails.length === 0);

  section("3. Simulating a process restart: rebuild the graph from Postgres, then resume approval");
  const graphAfterRestart = buildGraph(deps);
  const afterApproval = (await graphAfterRestart.invoke(
    new Command({ resume: { action: "approve" } }),
    config,
  )) as Record<string, unknown>;

  if (!afterApproval["__interrupt__"]) {
    throw new Error("FAILED: expected the graph to interrupt again at awaitResponse, but it did not");
  }
  console.log("   claimStatus after approval + send:", afterApproval["claimStatus"]);
  console.log("   Email sent:", emailSend.sentEmails.length === 1, "to:", emailSend.sentEmails[0]?.to);
  console.log("   Interrupted again at awaitResponse, as expected.");

  section("4. Resuming with the airline's (accepting) reply");
  const afterClassification = (await graph.invoke(
    new Command({ resume: { type: "reply", airlineReplyText: "We are pleased to accept this claim." } }),
    config,
  )) as Record<string, unknown>;

  if (!afterClassification["__interrupt__"]) {
    throw new Error("FAILED: expected the graph to interrupt at processPayout (awaiting payment), but it did not");
  }
  console.log("   Classified as:", (afterClassification["responseClassification"] as { category: string } | null)?.category);
  console.log("   Interrupted at processPayout, awaiting payment confirmation, as expected.");

  section("5. Resuming with payment confirmation → payout");
  const final = await graph.invoke(
    new Command({ resume: { receivedAmountCents: 60000, connectedAccountId: "acct_test" } }),
    config,
  );

  if (final.claimStatus !== "paid") {
    throw new Error(`FAILED: expected final claimStatus "paid", got "${final.claimStatus}"`);
  }
  console.log("   Final claimStatus:", final.claimStatus);
  console.log("   Payout:", JSON.stringify(final.payout));
  console.log("   Total emails sent across the run:", emailSend.sentEmails.length);
  console.log("   Total transfers:", payments.transfers.length);

  console.log("\nStage 2 end-to-end run verified: interrupts/resumes correctly at human-approval,");
  console.log("survives a simulated restart, and completes the full claim lifecycle.");

  await getCheckpointer().end();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

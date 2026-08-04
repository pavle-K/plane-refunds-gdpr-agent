/**
 * Sanity check for a connected inbox (npm run email:connect -- gmail|outlook
 * first). Lists recent messages, flags which ones look like booking
 * confirmations, and — if ANTHROPIC_API_KEY is set — shows what the real
 * extractor would parse out of each one. Doesn't touch the claim pipeline.
 *
 * Usage: npx tsx scripts/check-inbox.ts [--days 90]
 */
import { createEmailIngestProvider } from "../src/providers/email-ingest/index.js";
import { looksLikeBookingEmail } from "../src/providers/email-ingest/booking-parser.js";
import { createLlmBookingExtractor } from "../src/providers/email-ingest/llm-extractor.js";
import { createLlmClient, FakeLlmClient } from "../src/agent/llm/index.js";
import { pool } from "../src/db/client.js";

function getArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

async function main() {
  const days = Number(getArg("days", "90"));
  const sinceUtc = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const provider = await createEmailIngestProvider();
  console.log(`Using: ${provider.constructor.name}`);
  if (provider.constructor.name === "FakeEmailIngestAdapter") {
    console.log("No real inbox connected — run `npm run email:connect -- gmail` (or outlook) first.");
    await pool.end();
    return;
  }

  console.log(`Listing messages since ${sinceUtc}...\n`);
  const result = await provider.listRecentMessages({ sinceUtc });

  if (!result.ok) {
    console.error("FAILED to list messages:", result.error);
    await pool.end();
    process.exit(1);
  }

  console.log(`Found ${result.value.length} message(s).\n`);

  const llm = createLlmClient();
  const extractor = createLlmBookingExtractor(llm);

  for (const message of result.value) {
    const isBooking = looksLikeBookingEmail(message.bodyText);
    console.log(`- [${isBooking ? "BOOKING?" : "skip"}] ${message.subject}  (from: ${message.from}, ${message.receivedAtUtc})`);

    if (isBooking) {
      if (llm instanceof FakeLlmClient) {
        console.log("    (set ANTHROPIC_API_KEY to see the real parsed booking)");
        continue;
      }
      const parsed = await extractor(message.bodyText);
      console.log("    parsed:", parsed ? JSON.stringify(parsed) : "(extractor found no valid booking)");
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

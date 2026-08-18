/**
 * Sanity check for a connected inbox (npm run email:connect -- gmail|outlook
 * first). Lists recent messages, flags which ones look like booking
 * confirmations, and — if LLM_PROVIDER's key/config is set — shows what the real
 * extractor would parse out of each one. Doesn't touch the claim pipeline.
 *
 * Usage: npx tsx scripts/check-inbox.ts [--days 90]
 *        npx tsx scripts/check-inbox.ts --start 2024-02-01 --end 2024-03-31
 */
import { createEmailIngestProvider, FakeEmailIngestAdapter } from "../src/providers/email-ingest/index.js";
import { looksLikeBookingEmail } from "../src/providers/email-ingest/booking-parser.js";
import { createLlmBookingExtractor } from "../src/providers/email-ingest/llm-extractor.js";
import { createChatModel } from "../src/agent/llm/chat-model.js";
import { FakeChatModel } from "../src/agent/llm/fake-chat-model.js";
import { env } from "../src/config/env.js";
import { pool, assertDatabaseConfigured } from "../src/db/client.js";
import { ConversationRepo } from "../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../src/db/repositories/user.repo.js";

// Same (channel, externalId) pair scripts/chat.ts and scripts/connect-email.ts
// use for the CLI operator, so this resolves the same user's connection.
const CLI_CHANNEL = "cli";
const CLI_EXTERNAL_ID = "local";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

async function main() {
  assertDatabaseConfigured();

  const startArg = getArg("start");
  const endArg = getArg("end");
  const days = Number(getArg("days") ?? "90");

  const sinceUtc = startArg ? `${startArg}T00:00:00.000Z` : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const untilUtc = endArg ? `${endArg}T23:59:59.999Z` : undefined;

  const channelIdentityId = await new ConversationRepo().getOrCreateIdentity(CLI_CHANNEL, CLI_EXTERNAL_ID);
  const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
  if (!userId) {
    throw new Error(`Failed to resolve the local CLI user (channel identity ${channelIdentityId}).`);
  }

  const provider = await createEmailIngestProvider(userId);
  console.log(`Using: ${provider.constructor.name}`);
  if (provider instanceof FakeEmailIngestAdapter) {
    console.log(
      "No real inbox connected — run `npm run email:connect -- gmail` (or outlook) first. " +
        "(If one is already connected, check that TOKEN_ENCRYPTION_KEY is set — without it stored " +
        "mailbox credentials can't be read and this falls back to the fake adapter.)",
    );
    await pool.end();
    return;
  }

  console.log(`Listing messages from ${sinceUtc}${untilUtc ? ` to ${untilUtc}` : ""}...\n`);
  const result = await provider.listRecentMessages({ sinceUtc, ...(untilUtc ? { untilUtc } : {}) });

  if (!result.ok) {
    console.error("FAILED to list messages:", result.error);
    await pool.end();
    process.exit(1);
  }

  const { messages, truncated } = result.value;
  console.log(`Found ${messages.length} message(s).${truncated ? " ⚠️  TRUNCATED — more messages exist beyond the safety cap; narrow the date range for complete results." : ""}\n`);

  const model = createChatModel();
  const extractor = createLlmBookingExtractor(model);

  for (const message of messages) {
    const isBooking = looksLikeBookingEmail(message.bodyText);
    console.log(`- [${isBooking ? "BOOKING?" : "skip"}] ${message.subject}  (from: ${message.from}, ${message.receivedAtUtc})`);

    if (isBooking) {
      if (model instanceof FakeChatModel) {
        console.log(`    (configure LLM_PROVIDER=${env.LLM_PROVIDER}'s key/config to see the real parsed booking)`);
        continue;
      }
      const parsed = await extractor(message, (filename) => provider.getAttachmentText(message.id, filename));
      console.log("    parsed:", parsed ? JSON.stringify(parsed) : "(extractor found no valid booking)");
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

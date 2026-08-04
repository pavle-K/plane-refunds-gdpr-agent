import type { EmailIngestProvider } from "./email-ingest.port.js";
import { FakeEmailIngestAdapter } from "./fake.adapter.js";

export * from "./email-ingest.port.js";
export { FakeEmailIngestAdapter } from "./fake.adapter.js";
export * from "./booking-parser.js";

/**
 * No real adapter exists yet — Gmail/Outlook OAuth (CLAUDE.md §2.3) needs an actual
 * OAuth app registered in Google Cloud Console before a gmail.adapter.ts can be
 * built and tested against anything real.
 */
export function createEmailIngestProvider(): EmailIngestProvider {
  return new FakeEmailIngestAdapter();
}

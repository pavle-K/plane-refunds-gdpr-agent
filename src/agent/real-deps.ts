import { createFlightStatusProvider } from "../providers/flight-status/index.js";
import { createWeatherProvider } from "../providers/weather/index.js";
import { createDisruptionProvider } from "../providers/disruption/index.js";
import { createAirlineDirectoryProvider } from "../providers/airline-directory/index.js";
import { createEmailSendProvider } from "../providers/email-send/index.js";
import { createPaymentsProvider } from "../providers/payments/index.js";
import { createLlmClient } from "./llm/index.js";
import { createLlmBookingExtractor } from "../providers/email-ingest/llm-extractor.js";
import { DbAuditLog } from "../compliance/audit-log.js";
import type { GraphDeps } from "./graph.js";

/**
 * Builds GraphDeps from the real factories — each one individually picks its
 * live adapter if configured, fake otherwise (see src/providers/*\/index.ts).
 * Shared by every entry point that runs the actual graph outside tests
 * (scripts/start-claim.ts, scripts/resume-claim.ts, the chat operator).
 */
export function createRealGraphDeps(): GraphDeps {
  const llm = createLlmClient();
  return {
    extractor: createLlmBookingExtractor(llm),
    flightStatus: createFlightStatusProvider(),
    weather: createWeatherProvider(),
    disruption: createDisruptionProvider(),
    airlineDirectory: createAirlineDirectoryProvider(),
    emailSend: createEmailSendProvider(),
    payments: createPaymentsProvider(),
    llm,
    auditLog: new DbAuditLog(),
  };
}

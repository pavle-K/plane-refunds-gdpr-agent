import { Langfuse } from "langfuse";
import { env } from "../../config/env.js";

const DEFAULT_EU_HOST = "https://cloud.langfuse.com";

let cached: Langfuse | null | undefined;

/**
 * Returns a shared Langfuse client, or null when it isn't configured — same
 * fallback shape every other provider factory in this repo uses (a channel
 * with no token falls back to its fake adapter; here, no keys means tracing
 * and eval-reporting silently no-op rather than throwing). Memoized because
 * the SDK batches and flushes events on an internal timer; constructing a
 * fresh client per call would mean most events never get flushed before the
 * client is garbage collected.
 *
 * Defaults to Langfuse Cloud's EU region when LANGFUSE_HOST is unset — this
 * project keeps Postgres in Frankfurt specifically for EU data residency,
 * and a trace can carry a full raw prompt, which includes
 * passenger PII (a booking reference, a name, occasionally an email address
 * pulled straight from a real conversation). That reasoning applies here too.
 */
export function getLangfuseClient(): Langfuse | null {
  if (cached !== undefined) {
    return cached;
  }

  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    cached = null;
    return cached;
  }

  cached = new Langfuse({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_HOST ?? DEFAULT_EU_HOST,
  });
  return cached;
}

/** Test-only: clears the memoized client so a test can reconfigure env and
 * re-resolve. Never called from application code. */
export function resetLangfuseClientForTests(): void {
  cached = undefined;
}

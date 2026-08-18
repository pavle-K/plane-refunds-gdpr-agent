import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { assertDatabaseConfigured, pool } from "../db/client.js";

let saver: PostgresSaver | undefined;

/**
 * Shares db/client.ts's single pg.Pool rather than PostgresSaver.fromConnString,
 * which would open a second, entirely separate pool to the same database.
 * Since the LangChain convergence (see src/operator/session.ts), the operator
 * agent hits this checkpointer on every turn, not just claim-graph runs — two
 * pools per process instead of one measurably added to real Postgres
 * connection contention under concurrent load (surfaced as integration-test
 * timeouts under vitest's parallel workers).
 */
export function getCheckpointer(): PostgresSaver {
  assertDatabaseConfigured();
  saver ??= new PostgresSaver(pool);
  return saver;
}

// Must run once before first use — creates the checkpoint tables if they don't exist.
export async function setupCheckpointer(): Promise<void> {
  await getCheckpointer().setup();
}

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { env } from "../config/env.js";

let saver: PostgresSaver | undefined;

export function getCheckpointer(): PostgresSaver {
  saver ??= PostgresSaver.fromConnString(env.DATABASE_URL);
  return saver;
}

// Must run once before first use — creates the checkpoint tables if they don't exist.
export async function setupCheckpointer(): Promise<void> {
  await getCheckpointer().setup();
}

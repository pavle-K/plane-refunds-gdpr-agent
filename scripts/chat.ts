/**
 * Talk to the operator instead of running scripts with flags. Wraps
 * connect-email, inbox scanning, and the claim pipeline (start/approve/edit/
 * decline/resume) as tools an LLM tool-use loop calls based on what you say —
 * see src/operator/prompt.md for the agent's instructions and
 * src/operator/tools.ts for what it can actually do. Runs on whichever
 * LLM_PROVIDER is configured (src/agent/llm/index.ts) — Anthropic, OpenAI, xAI,
 * Google, or any OpenAI-compatible endpoint, including a local Ollama.
 *
 * This is one of several front doors onto the same conversation — the actual
 * turn-handling logic lives in src/operator/session.ts and is shared with every
 * messaging channel (see src/channels/). This script is just a readline loop
 * around it, using channel "cli" with a fixed local identity.
 *
 * Usage: npm run chat
 */
import { createInterface } from "node:readline/promises";
import { setupCheckpointer, getCheckpointer } from "../src/agent/checkpointer.js";
import { createLlmClient, FakeLlmClient } from "../src/agent/llm/index.js";
import { handleTurn } from "../src/operator/session.js";
import { env } from "../src/config/env.js";

const CLI_EXTERNAL_ID = "local";

async function main() {
  const llm = createLlmClient();
  if (llm instanceof FakeLlmClient) {
    throw new Error(
      `LLM_PROVIDER=${env.LLM_PROVIDER} has no key/config set (see .env) — the operator can't chat without a real LLM.`,
    );
  }

  console.log("Setting up checkpointer against real Postgres...");
  await setupCheckpointer();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nConnected (LLM_PROVIDER=${env.LLM_PROVIDER}). Type a message (or 'exit' to quit).\n`);

  for (;;) {
    let userInput: string;
    try {
      userInput = await rl.question("you> ");
    } catch {
      break; // stdin closed (e.g. piped input ran out, or Ctrl+D) — exit cleanly
    }
    if (userInput.trim().toLowerCase() === "exit") {
      break;
    }

    const responseText = await handleTurn(llm, {
      channel: "cli",
      externalId: CLI_EXTERNAL_ID,
      text: userInput,
      onToolCall: (call) => console.log(`  [${call.name}(${JSON.stringify(call.input)})]`),
    });
    console.log(`\nagent> ${responseText}\n`);
  }

  rl.close();
  await getCheckpointer().end();
  process.exit(0);
}

main().catch((cause) => {
  console.error("\nFAILED:", cause);
  process.exit(1);
});

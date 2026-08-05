/**
 * Talk to the operator instead of running scripts with flags. Wraps
 * connect-email, inbox scanning, and the claim pipeline (start/approve/edit/
 * decline/resume) as tools an LLM tool-use loop calls based on what you say —
 * see src/operator/prompt.md for the agent's instructions and
 * src/operator/tools.ts for what it can actually do. Runs on whichever
 * LLM_PROVIDER is configured (src/agent/llm/index.ts) — Anthropic, OpenAI, xAI,
 * Google, or any OpenAI-compatible endpoint, including a local Ollama.
 *
 * Usage: npm run chat
 */
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setupCheckpointer, getCheckpointer } from "../src/agent/checkpointer.js";
import { createLlmClient, FakeLlmClient, type LlmConversationTurn } from "../src/agent/llm/index.js";
import { TOOL_DEFINITIONS, OperatorTools } from "../src/operator/tools.js";
import { env } from "../src/config/env.js";

const BASE_SYSTEM_PROMPT = readFileSync(fileURLToPath(new URL("../src/operator/prompt.md", import.meta.url)), "utf-8");

/**
 * The model has no other way to know today's date — without this it falls back to
 * guessing from training data, which silently resolves things like "check March"
 * to the wrong year. Computed fresh per call (not baked in once) so a
 * long-running session stays correct if it crosses midnight.
 */
function buildSystemPrompt(): string {
  const now = new Date();
  return `${BASE_SYSTEM_PROMPT}\n\n## Current date and time\n\nRight now it is ${now.toISOString()} (UTC) — today's date is ${now.toISOString().slice(0, 10)}. Always resolve dates the user gives you (a bare month name, "last week", "this year", a relative range) against THIS date, never against your training data or an assumed year.`;
}

async function main() {
  const llm = createLlmClient();
  if (llm instanceof FakeLlmClient) {
    throw new Error(
      `LLM_PROVIDER=${env.LLM_PROVIDER} has no key/config set (see .env) — the operator can't chat without a real LLM.`,
    );
  }

  console.log("Setting up checkpointer against real Postgres...");
  await setupCheckpointer();

  const tools = new OperatorTools();
  const history: LlmConversationTurn[] = [];

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

    const responseText = await llm.completeWithTools({
      system: buildSystemPrompt(),
      prompt: userInput,
      tools: TOOL_DEFINITIONS,
      history,
      onToolCall: async (call) => {
        console.log(`  [${call.name}(${JSON.stringify(call.input)})]`);
        try {
          const result = await tools.dispatch(call.name, call.input);
          return JSON.stringify(result);
        } catch (cause) {
          return JSON.stringify({ error: String(cause) });
        }
      },
    });

    console.log(`\nagent> ${responseText}\n`);
    history.push({ role: "user", content: userInput }, { role: "assistant", content: responseText });
  }

  rl.close();
  await getCheckpointer().end();
  process.exit(0);
}

main().catch((cause) => {
  console.error("\nFAILED:", cause);
  process.exit(1);
});

/**
 * Talk to the operator instead of running scripts with flags. Wraps
 * connect-email, inbox scanning, and the claim pipeline (start/approve/edit/
 * decline/resume) as tools an actual Claude tool-use loop calls based on what
 * you say — see src/operator/prompt.md for the agent's instructions and
 * src/operator/tools.ts for what it can actually do.
 *
 * Usage: npm run chat
 */
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { setupCheckpointer, getCheckpointer } from "../src/agent/checkpointer.js";
import { TOOL_DEFINITIONS, OperatorTools } from "../src/operator/tools.js";
import { env } from "../src/config/env.js";

const BASE_SYSTEM_PROMPT = readFileSync(fileURLToPath(new URL("../src/operator/prompt.md", import.meta.url)), "utf-8");
const MODEL = "claude-sonnet-5";

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
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required to chat with the operator.");
  }

  console.log("Setting up checkpointer against real Postgres...");
  await setupCheckpointer();

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const tools = new OperatorTools();
  const messages: Anthropic.MessageParam[] = [];

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nConnected. Type a message (or 'exit' to quit).\n");

  outer: while (true) {
    let userInput: string;
    try {
      userInput = await rl.question("you> ");
    } catch {
      break; // stdin closed (e.g. piped input ran out, or Ctrl+D) — exit cleanly
    }
    if (userInput.trim().toLowerCase() === "exit") {
      break;
    }
    messages.push({ role: "user", content: userInput });

    // Agentic loop: keep calling the model until it responds without requesting a tool.
    for (;;) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: buildSystemPrompt(),
        tools: TOOL_DEFINITIONS,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text") {
          console.log(`\nagent> ${block.text}\n`);
        }
      }

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      if (toolUseBlocks.length === 0) {
        continue outer;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`  [${toolUse.name}(${JSON.stringify(toolUse.input)})]`);
        try {
          const result = await tools.dispatch(toolUse.name, toolUse.input as Record<string, unknown>);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) });
        } catch (cause) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: String(cause) }),
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }
  }

  rl.close();
  await getCheckpointer().end();
  process.exit(0);
}

main().catch((cause) => {
  console.error("\nFAILED:", cause);
  process.exit(1);
});

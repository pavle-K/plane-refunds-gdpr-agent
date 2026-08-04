/**
 * Resumes a claim thread started by start-claim.ts, whenever the event it was
 * waiting on actually arrives (an airline reply, a payment confirmation).
 * Auto-detects which node is paused and prompts for the right kind of input.
 *
 * Usage: npx tsx scripts/resume-claim.ts --thread claim-1234567890
 */
import { createInterface } from "node:readline/promises";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "../src/agent/graph.js";
import { getCheckpointer } from "../src/agent/checkpointer.js";
import { createRealGraphDeps } from "../src/agent/real-deps.js";
import { FakeEmailSendAdapter } from "../src/providers/email-send/index.js";
import { FakeLlmClient } from "../src/agent/llm/index.js";

function getArg(name: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  const value = idx !== -1 ? process.argv[idx + 1] : undefined;
  if (value === undefined) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

async function main() {
  const threadId = getArg("thread");
  const deps = createRealGraphDeps();
  const { llm, emailSend } = deps;

  const graph = buildGraph(deps);
  const config = { configurable: { thread_id: threadId } };

  const state = await graph.getState(config);
  const pausedNode = state.next[0];

  if (!pausedNode) {
    console.log("This thread isn't paused on anything — final state:");
    console.log(JSON.stringify(state.values, null, 2));
    await getCheckpointer().end();
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let resumeValue: unknown;

  if (pausedNode === "humanApproval") {
    console.log("\nPaused at: human approval (a rebuttal draft, most likely)");
    console.log("\n=== Draft ===\n", state.values.draftText);
    const answer = (await rl.question("\nApprove (a) / Edit (e) / Decline (d)? ")).trim().toLowerCase();
    if (answer === "d" || answer === "decline") {
      resumeValue = { action: "decline" };
    } else if (answer === "e" || answer === "edit") {
      const editedText = await rl.question("Enter the full edited claim text:\n> ");
      resumeValue = { action: "edit", editedText };
    } else {
      resumeValue = { action: "approve" };
    }
  } else if (pausedNode === "awaitResponse") {
    console.log("\nPaused at: awaiting the airline's response.");
    const hasReply = (await rl.question("Do you have a reply to paste in? (y/n) ")).trim().toLowerCase();
    if (hasReply === "y") {
      const airlineReplyText = await rl.question("Paste the airline's reply text:\n> ");
      resumeValue = { type: "reply", airlineReplyText };
      if (llm instanceof FakeLlmClient) {
        console.log("No ANTHROPIC_API_KEY — queuing a generic 'accepted' classification as a fallback.");
        console.log("(If the real reply is a rejection, classification will be wrong without a real key.)");
        llm.enqueueJson({ category: "accepted", reasoning: "Generic fallback — no ANTHROPIC_API_KEY set.", requestedInfo: null });
      }
    } else {
      resumeValue = { type: "timeout" };
    }
  } else if (pausedNode === "processPayout") {
    console.log("\nPaused at: awaiting payment confirmation.");
    const receivedAmountCents = Number(await rl.question("Amount actually received, in cents: "));
    const connectedAccountId = await rl.question("Stripe Connect account id to pay out to: ");
    resumeValue = { receivedAmountCents, connectedAccountId };
  } else {
    rl.close();
    throw new Error(`Don't know how to resume a claim paused at "${pausedNode}"`);
  }

  rl.close();

  const result = (await graph.invoke(new Command({ resume: resumeValue }), config)) as Record<string, unknown>;

  console.log("\nclaimStatus:", result["claimStatus"]);
  if (emailSend instanceof FakeEmailSendAdapter && emailSend.sentEmails.length > 0) {
    console.log("Sent (fake):", JSON.stringify(emailSend.sentEmails.at(-1)));
  }
  if (result["__interrupt__"]) {
    console.log(`\nPaused again. Resume later with:\n  npx tsx scripts/resume-claim.ts --thread ${threadId}`);
  } else {
    console.log("Final state:", JSON.stringify(result, null, 2));
  }

  await getCheckpointer().end();
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

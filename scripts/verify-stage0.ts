/**
 * Stage 0 deliverable check (CLAUDE.md): "project boots, connects to Postgres,
 * runs a trivial LangGraph graph with checkpointing, no real logic yet."
 *
 * Not part of the automated test suite (tests/ never hits a live service) —
 * this is a one-off manual verification against the real Neon database.
 * Run with: npm run verify:stage0
 */
import { Client } from "pg";
import { StateGraph, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { env } from "../src/config/env.js";
import { GraphState, type GraphStateType } from "../src/agent/state.js";

function stepOne(_state: GraphStateType) {
  return { stepsCompleted: ["stepOne"] };
}

function stepTwo(_state: GraphStateType) {
  return { stepsCompleted: ["stepTwo"] };
}

function buildGraphWith(checkpointer: PostgresSaver) {
  return new StateGraph(GraphState)
    .addNode("stepOne", stepOne)
    .addNode("stepTwo", stepTwo)
    .addEdge(START, "stepOne")
    .addEdge("stepOne", "stepTwo")
    .addEdge("stepTwo", END)
    .compile({ checkpointer });
}

async function main() {
  console.log("1. Raw Postgres connectivity check...");
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query("SELECT NOW() AS now");
  console.log(`   Connected. Server time: ${rows[0].now}`);
  await client.end();

  const threadId = `stage0-verify-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  console.log("\n2. First graph instance: setup checkpointer + run graph...");
  const saverA = PostgresSaver.fromConnString(env.DATABASE_URL);
  await saverA.setup();
  const graphA = buildGraphWith(saverA);
  const resultA = await graphA.invoke({ stepsCompleted: [] }, config);
  console.log(`   Graph ran. stepsCompleted = ${JSON.stringify(resultA.stepsCompleted)}`);
  await saverA.end();

  console.log("\n3. Fresh graph instance (simulating a process restart)...");
  const saverB = PostgresSaver.fromConnString(env.DATABASE_URL);
  const graphB = buildGraphWith(saverB);
  const state = await graphB.getState(config);
  console.log(`   Reloaded state from Postgres: ${JSON.stringify(state.values)}`);
  await saverB.end();

  const expected = ["stepOne", "stepTwo"];
  const actual = state.values.stepsCompleted;
  const matches = JSON.stringify(actual) === JSON.stringify(expected);

  if (!matches) {
    console.error(`\nFAILED: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }

  console.log("\nStage 0 checkpointing round-trip verified against Neon Postgres.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});

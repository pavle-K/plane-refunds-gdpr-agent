import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    passWithNoTests: false,
    // Default 5000ms started intermittently timing out real-Postgres
    // integration tests once the operator agent (src/operator/session.ts)
    // began hitting the checkpointer on every turn, not just claim-graph
    // runs — several real network round trips per test against a remote
    // Postgres instance, run across many parallel vitest workers each
    // opening their own connection pool. Not a hang; a real but occasionally
    // slow round trip. 15s gives real headroom without masking an actual hang.
    testTimeout: 15000,
  },
});

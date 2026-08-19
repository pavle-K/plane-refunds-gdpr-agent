/**
 * One command for local web-frontend development — starts the Express
 * backend and the web/ Vite dev server together, both torn down on Ctrl+C.
 * Simpler than scripts/dev-telegram.ts: a browser talking to two localhost
 * ports needs no public tunnel, so there's no ngrok step and no webhook to
 * register.
 *
 * Note: exercising the REAL Gmail/Outlook OAuth popup still needs a public
 * PUBLIC_URL (the hosted OAuth flow's redirect URI can't be localhost) — use
 * npm run dev:telegram's ngrok tunnel, or a deployed environment, for that
 * specific flow. Everything else works against pure localhost.
 *
 * Usage: npm run dev:web
 */
import { spawn, type ChildProcess } from "node:child_process";
import { env } from "../src/config/env.js";

const children: ChildProcess[] = [];

function spawnTracked(command: string, args: string[], options: { cwd?: string } = {}): ChildProcess {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.push(child);
  return child;
}

async function waitFor(condition: () => Promise<boolean>, attempts: number, delayMs: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function shutdown(exitCode: number): never {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(exitCode);
}

async function main() {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => shutdown(0));
  }

  console.log(`Starting the backend on port ${env.PORT}...`);
  const server = spawnTracked("npx", ["tsx", "src/api/server.ts"]);
  server.once("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`\nBackend exited unexpectedly (code ${code}).`);
      shutdown(code);
    }
  });

  const serverUp = await waitFor(
    async () => {
      try {
        const res = await fetch(`http://localhost:${env.PORT}/healthz`);
        return res.ok;
      } catch {
        return false;
      }
    },
    20,
    500,
  );
  if (!serverUp) {
    console.error(`\nBackend never became reachable at http://localhost:${env.PORT}/healthz — see its output above.`);
    shutdown(1);
  }
  console.log("  Backend is up.");

  console.log("\nStarting the web frontend (Vite dev server)...");
  spawnTracked("npm", ["run", "dev"], { cwd: "web" });

  console.log("\n" + "─".repeat(60));
  console.log("Open the URL Vite prints above (usually http://localhost:5173).");
  console.log("The real Gmail/Outlook OAuth popup needs a public PUBLIC_URL — see npm run");
  console.log("dev:telegram's ngrok setup, or a deployed environment. Everything else works");
  console.log("against pure localhost. Ctrl+C here stops everything.");
  console.log("─".repeat(60) + "\n");
}

main().catch((cause) => {
  console.error("\nFAILED:", cause);
  shutdown(1);
});

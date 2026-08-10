/**
 * One command for the full "test the hosted OAuth + Telegram flow for real"
 * setup described in the README's "Connecting messaging channels" section —
 * replaces manually juggling three terminals (ngrok, npm run server,
 * npm run telegram:setup) and hand-copying the tunnel URL into PUBLIC_URL.
 *
 * What this does NOT do — and can't, since both are actions on a console this
 * script has no access to — is register the OAuth redirect URI with Google/
 * Microsoft, or add yourself as a test user on a Google OAuth consent screen
 * still in "Testing" mode. It prints the exact values you need for both.
 *
 * Set NGROK_STATIC_DOMAIN in .env to a domain from https://dashboard.ngrok.com/domains
 * (ngrok's free plan includes one) and every run uses that exact domain —
 * register its redirect URI in Google/Microsoft once, never touch it again.
 * Without it, ngrok picks a domain itself; recent free-tier accounts get one
 * persistent "dev domain" reused automatically, but this makes it explicit
 * rather than relying on that default.
 *
 * Usage: npm run dev:telegram
 */
import { spawn, type ChildProcess } from "node:child_process";
import { env } from "../src/config/env.js";
import { detectNgrokUrl } from "./lib/ngrok.js";

const children: ChildProcess[] = [];

function spawnTracked(command: string, args: string[], extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(command, args, {
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
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

async function ensureNgrokTunnel(): Promise<string> {
  const staticDomain = process.env["NGROK_STATIC_DOMAIN"];

  const existing = await detectNgrokUrl(env.PORT);
  if (existing) {
    if (staticDomain && !existing.includes(staticDomain)) {
      console.warn(
        `Note: a tunnel is already running (${existing}) that doesn't match ` +
          `NGROK_STATIC_DOMAIN=${staticDomain} — using the running one. Stop it first ` +
          "(check for another ngrok process) if you want the static domain instead.",
      );
    }
    console.log(`Found an existing ngrok tunnel to port ${env.PORT}: ${existing}`);
    return existing;
  }

  const ngrokArgs = staticDomain ? ["http", "--domain", staticDomain, String(env.PORT)] : ["http", String(env.PORT)];
  console.log(`Starting ngrok (tunnel to port ${env.PORT}${staticDomain ? `, domain ${staticDomain}` : ""})...`);
  const ngrok = spawn("ngrok", ngrokArgs, { stdio: "ignore" });
  children.push(ngrok);

  const spawnFailed = await new Promise<boolean>((resolve) => {
    ngrok.once("error", () => resolve(true));
    // If it hasn't errored shortly after spawning, assume the binary exists
    // and it's starting up normally — ngrok's own startup (auth, tunnel
    // negotiation) takes longer than this and is handled by the poll below.
    setTimeout(() => resolve(false), 300);
  });
  if (spawnFailed) {
    console.error(
      "\nCouldn't start ngrok — is it installed?\n" +
        "  brew install ngrok          # or: brew install --cask ngrok\n" +
        "  ngrok config add-authtoken <token>   # free account at https://dashboard.ngrok.com\n",
    );
    shutdown(1);
  }

  console.log("Waiting for the tunnel to come up...");
  const tunnelUrl = await (async () => {
    for (let i = 0; i < 20; i++) {
      const url = await detectNgrokUrl(env.PORT);
      if (url) {
        return url;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  })();

  if (!tunnelUrl) {
    console.error("\nngrok started but never exposed a tunnel — check its dashboard at http://127.0.0.1:4040.");
    shutdown(1);
  }
  console.log(`  Tunnel ready: ${tunnelUrl}`);
  return tunnelUrl;
}

async function main() {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    console.error(
      "TELEGRAM_BOT_TOKEN and/or TELEGRAM_WEBHOOK_SECRET aren't set in .env — see the README's " +
        '"Connecting messaging channels" section for how to get both, then re-run this.\n',
    );
    process.exit(1);
  }
  if (!env.GMAIL_OAUTH_CLIENT_ID && !env.OUTLOOK_OAUTH_CLIENT_ID) {
    console.warn(
      "Note: no GMAIL_OAUTH_CLIENT_ID or OUTLOOK_OAUTH_CLIENT_ID set — Telegram chat will work, " +
        "but connect_email will fail until at least one is configured.\n",
    );
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => shutdown(0));
  }

  const tunnelUrl = await ensureNgrokTunnel();

  console.log(`\nStarting the server with PUBLIC_URL=${tunnelUrl}...`);
  const server = spawnTracked("npx", ["tsx", "src/api/server.ts"], { PUBLIC_URL: tunnelUrl });
  server.once("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`\nServer exited unexpectedly (code ${code}).`);
      shutdown(code);
    }
  });

  const serverUp = await waitFor(async () => {
    try {
      const res = await fetch(`http://localhost:${env.PORT}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }, 20, 500);
  if (!serverUp) {
    console.error(`\nServer never became reachable at http://localhost:${env.PORT}/healthz — see its output above.`);
    shutdown(1);
  }
  console.log("  Server is up.");

  console.log("\nRegistering the Telegram webhook...");
  const setup = spawnTracked("npx", ["tsx", "scripts/telegram-setup.ts", "--url", tunnelUrl]);
  const setupExitCode = await new Promise<number>((resolve) => {
    setup.once("exit", (code) => resolve(code ?? 1));
  });
  if (setupExitCode !== 0) {
    shutdown(setupExitCode);
  }

  const providers = [
    env.GMAIL_OAUTH_CLIENT_ID ? "gmail" : null,
    env.OUTLOOK_OAUTH_CLIENT_ID ? "outlook" : null,
  ].filter((p): p is string => p !== null);

  console.log("\n" + "─".repeat(60));
  console.log("Everything's running. Two things only you can do, in your browser:\n");
  if (providers.length > 0) {
    console.log("1. Add these as authorized redirect URIs (Google Cloud Console /");
    console.log("   Azure — alongside your existing localhost ones, don't remove those):");
    for (const provider of providers) {
      console.log(`     ${tunnelUrl}/oauth/${provider}/callback`);
    }
    console.log(
      process.env["NGROK_STATIC_DOMAIN"]
        ? "   (NGROK_STATIC_DOMAIN is set — this URL is permanent, register it once and you're done.)"
        : "   (No NGROK_STATIC_DOMAIN set — this URL may change on the next restart, on some accounts.\n" +
            "   Set NGROK_STATIC_DOMAIN in .env to a domain from https://dashboard.ngrok.com/domains\n" +
            "   to make it permanent and only ever do this once.)",
    );
  } else {
    console.log("1. (Skipped — no GMAIL_OAUTH_CLIENT_ID/OUTLOOK_OAUTH_CLIENT_ID set.)");
  }
  console.log("\n2. If your Google OAuth consent screen is still in \"Testing\" mode,");
  console.log("   make sure your own Google account is listed under Test users —");
  console.log("   otherwise Google will refuse to let you complete the OAuth flow.");
  console.log("\n" + "─".repeat(60));
  console.log("\nMessage your bot on Telegram to try it. Ctrl+C here stops everything.\n");
}

main().catch((cause) => {
  console.error("\nFAILED:", cause);
  shutdown(1);
});

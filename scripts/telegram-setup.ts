/**
 * Wires up the Telegram webhook end to end: validates TELEGRAM_BOT_TOKEN
 * against Telegram, figures out a public URL to register (auto-detecting a
 * running local ngrok tunnel, or use --url for a real hosted domain),
 * confirms the server is actually reachable there, then registers it —
 * replacing the hand-built curl commands from the README's Telegram
 * walkthrough with one command that tells you what's still missing.
 *
 * Usage: npm run telegram:setup
 *        npm run telegram:setup -- --url https://your-domain.com
 */
import { env } from "../src/config/env.js";
import { detectNgrokUrl } from "./lib/ngrok.js";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function callTelegram<T>(token: string, method: string, body?: Record<string, unknown>): Promise<TelegramApiResponse<T>> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return (await response.json()) as TelegramApiResponse<T>;
}

async function main() {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error(
      "TELEGRAM_BOT_TOKEN is not set in .env.\n" +
        "  1. Message @BotFather on Telegram, send /newbot, follow the prompts.\n" +
        "  2. Copy the token it gives you into .env as TELEGRAM_BOT_TOKEN=...\n",
    );
    process.exit(1);
  }
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    console.error(
      "TELEGRAM_WEBHOOK_SECRET is not set in .env.\n" +
        '  Generate one and add it: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"\n',
    );
    process.exit(1);
  }

  console.log("Checking TELEGRAM_BOT_TOKEN against Telegram...");
  const me = await callTelegram<{ username: string }>(env.TELEGRAM_BOT_TOKEN, "getMe");
  if (!me.ok || !me.result) {
    console.error(`Telegram rejected TELEGRAM_BOT_TOKEN: ${me.description ?? "unknown error"}`);
    process.exit(1);
  }
  console.log(`  Valid — this is @${me.result.username}`);

  const explicitUrl = getArg("url");
  let publicUrl = explicitUrl;
  if (!publicUrl) {
    console.log(`No --url given — looking for a running ngrok tunnel to port ${env.PORT}...`);
    publicUrl = (await detectNgrokUrl(env.PORT)) ?? undefined;
    if (!publicUrl) {
      console.error(
        `Couldn't find a running ngrok tunnel to port ${env.PORT}, and no --url was given.\n` +
          `  Either start one (\`ngrok http ${env.PORT}\`) and re-run this, or pass a public URL directly:\n` +
          `    npm run telegram:setup -- --url https://your-domain.com\n`,
      );
      process.exit(1);
    }
    console.log(`  Found: ${publicUrl}`);
  }
  publicUrl = publicUrl.replace(/\/$/, "");

  console.log(`Checking the server is reachable at ${publicUrl}...`);
  try {
    const health = await fetch(`${publicUrl}/healthz`);
    if (!health.ok) {
      throw new Error(`HTTP ${health.status}`);
    }
    console.log("  Reachable.");
  } catch (cause) {
    console.error(
      `  Couldn't reach ${publicUrl}/healthz (${String(cause)}).\n` +
        "  Is `npm run server` actually running, and is the tunnel pointed at the right port?\n",
    );
    process.exit(1);
  }

  const webhookUrl = `${publicUrl}/webhooks/telegram`;
  console.log(`Registering webhook: ${webhookUrl}`);
  const setResult = await callTelegram(env.TELEGRAM_BOT_TOKEN, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
  });
  if (!setResult.ok) {
    console.error(`Telegram refused setWebhook: ${setResult.description ?? "unknown error"}`);
    process.exit(1);
  }

  const info = await callTelegram<{ url: string; last_error_message?: string }>(env.TELEGRAM_BOT_TOKEN, "getWebhookInfo");
  if (info.ok && info.result?.last_error_message) {
    console.log(`  Note: Telegram reports a past delivery error, likely stale: ${info.result.last_error_message}`);
  }

  console.log(`\nDone — message @${me.result.username} on Telegram to try it.`);
}

main().catch((cause) => {
  console.error("\nFAILED:", cause);
  process.exit(1);
});

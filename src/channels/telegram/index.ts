import { env } from "../../config/env.js";
import type { ChannelAdapter } from "../channel.port.js";
import { FakeChannelAdapter } from "../fake.adapter.js";
import { TelegramAdapter } from "./telegram.adapter.js";

export { TelegramAdapter } from "./telegram.adapter.js";
export { parseTelegramUpdate } from "./telegram.webhook.js";

export function createTelegramAdapter(): ChannelAdapter {
  if (env.NODE_ENV === "test" || !env.TELEGRAM_BOT_TOKEN) {
    return new FakeChannelAdapter();
  }
  return new TelegramAdapter(env.TELEGRAM_BOT_TOKEN);
}

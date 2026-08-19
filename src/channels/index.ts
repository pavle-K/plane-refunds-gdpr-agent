import type { ChannelAdapter } from "./channel.port.js";
import { FakeChannelAdapter } from "./fake.adapter.js";
import { createTelegramAdapter } from "./telegram/index.js";
import { NullChannelAdapter } from "./null.adapter.js";

/**
 * Resolves the right adapter for a channel value stored on a channel_identity
 * row (e.g. "telegram", "cli") — used wherever code needs to push a message
 * to a user out-of-band rather than as a reply within a request/response
 * cycle (see src/api/routes/oauth.routes.ts's post-connect notification).
 * Falls back to the fake adapter for channels with no push mechanism (e.g.
 * "cli" — there's no way to interrupt a blocking readline loop) or not yet
 * built, same convention as every other provider factory in this repo.
 *
 * "web" deliberately does NOT fall into that default: FakeChannelAdapter
 * reports success for a push that never happened, which is the wrong
 * failure mode for a channel that has no push transport at all rather than
 * one that's merely unbuilt — see NullChannelAdapter's own doc comment.
 */
export function createChannelAdapter(channel: string): ChannelAdapter {
  switch (channel) {
    case "telegram":
      return createTelegramAdapter();
    case "web":
      return new NullChannelAdapter();
    default:
      return new FakeChannelAdapter();
  }
}

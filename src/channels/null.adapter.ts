import type { ChannelAdapter, ChannelSendError, OutboundDocument } from "./channel.port.js";
import type { Result } from "../lib/result.js";
import { err } from "../lib/result.js";

/**
 * The web channel's adapter — used wherever code needs to push a message to a
 * user out-of-band (see channels/index.ts's doc comment). Unlike Telegram,
 * a browser tab has no server-reachable push transport: there is no webhook
 * to call, no bot API to post to. The default fallback (FakeChannelAdapter)
 * would silently report success for a message that never actually reached
 * anyone, which is the wrong failure mode for something like the "you're
 * connected" OAuth notification (src/api/routes/oauth.routes.ts) — the web
 * frontend instead learns about that via its own chat/claims polling, not a
 * push, so a caller that reaches this adapter should know its push attempt
 * did nothing.
 */
export class NullChannelAdapter implements ChannelAdapter {
  async sendMessage(_externalUserId: string, _text: string): Promise<Result<void, ChannelSendError>> {
    return err({
      type: "upstream_error",
      message: "The web channel has no out-of-band push transport — nothing was sent.",
    });
  }

  async sendDocument(
    _externalUserId: string,
    _document: OutboundDocument,
    _caption?: string,
  ): Promise<Result<void, ChannelSendError>> {
    return err({
      type: "upstream_error",
      message: "The web channel has no out-of-band push transport — nothing was sent.",
    });
  }
}

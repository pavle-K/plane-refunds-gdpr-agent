import { Router, type Request, type Response } from "express";
import { completeHostedFlow } from "../../providers/email-ingest/hosted-oauth.js";

/**
 * The public landing page a user's browser hits after they finish Google's or
 * Microsoft's consent screen. Deliberately minimal (per the chosen "minimal
 * static confirmation" design) — the real "you're connected" moment is a
 * proactive chat message sent from here, wired in Segment 4 once the operator
 * integration (channel adapters) exists. This route alone is fully
 * self-contained and testable: given a pending-flow row and a mocked token
 * exchange, does it store the connection and reject reuse/expiry/tampering?
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(title: string, message: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; text-align: center; color: #222;">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>`;
}

const TRY_AGAIN_MESSAGE = "This link is no longer valid — please ask the bot to send you a new connection link.";

export function createOAuthCallbackRouter(): Router {
  const router = Router();

  router.get("/oauth/:provider/callback", async (req: Request, res: Response) => {
    const provider = req.params["provider"];
    if (provider !== "gmail" && provider !== "outlook") {
      res.status(404).type("html").send(renderPage("Not found", "Unknown provider."));
      return;
    }

    const state = typeof req.query["state"] === "string" ? req.query["state"] : null;
    const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
    const error = typeof req.query["error"] === "string" ? req.query["error"] : null;

    if (!state) {
      res.status(400).type("html").send(renderPage("Something went wrong", TRY_AGAIN_MESSAGE));
      return;
    }

    const result = await completeHostedFlow(state, { code, error });

    if (!result.ok) {
      console.error(`OAuth callback failed (provider=${provider}, state=${state}):`, result.error);
      if (result.error.type === "provider_denied") {
        res
          .status(200)
          .type("html")
          .send(renderPage("No problem", "You can connect your inbox anytime by asking the bot to try again."));
        return;
      }
      res.status(400).type("html").send(renderPage("Something went wrong", TRY_AGAIN_MESSAGE));
      return;
    }

    res
      .status(200)
      .type("html")
      .send(renderPage("Connected", `${result.value.emailAddress} is now connected — you can return to your chat.`));
  });

  return router;
}

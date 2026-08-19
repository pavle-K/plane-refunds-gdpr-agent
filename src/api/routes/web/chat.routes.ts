import { Router, type Request, type Response } from "express";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { handleTurn } from "../../../operator/session.js";
import { extractWebActions, type ToolCallRecord } from "../../../operator/web-actions.js";
import { LlmRateLimitedError } from "../../../agent/llm/rate-limit-error.js";
import { ConversationRepo } from "../../../db/repositories/conversation.repo.js";
import { resolveWebIdentity } from "./resolve-web-user.js";
import { logger } from "../../../lib/logger.js";

/**
 * The web frontend's front door onto the same operator conversation pipeline
 * the CLI (scripts/chat.ts) and Telegram (channels/telegram) already use —
 * see src/operator/session.ts's own doc comment: one conversation pipeline,
 * many front doors. externalId is the web-session cookie value
 * (req.webSessionId, set by web-session.ts), so handleTurn resolves this
 * browser to the exact same channel_identities row on every request.
 */
export function createChatRouter(model: BaseChatModel): Router {
  const router = Router();

  router.get("/api/web/chat/history", async (req: Request, res: Response) => {
    const { channelIdentityId } = await resolveWebIdentity(req);
    const turns = await new ConversationRepo().loadHistory(channelIdentityId);
    res.json({ turns });
  });

  router.post("/api/web/chat", async (req: Request, res: Response) => {
    const sessionId = req.webSessionId;
    if (!sessionId) {
      res.status(500).json({ error: "No session established for this request." });
      return;
    }

    const text = typeof req.body?.["text"] === "string" ? (req.body["text"] as string).trim() : "";
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const toolCalls: ToolCallRecord[] = [];
    try {
      const reply = await handleTurn(model, {
        channel: "web",
        externalId: sessionId,
        text,
        onToolCall: (call) => toolCalls.push(call),
      });
      res.json({ reply, actions: extractWebActions(toolCalls) });
    } catch (cause) {
      if (cause instanceof LlmRateLimitedError) {
        res.status(429).json({
          error: "rate_limited",
          message: cause.message,
          ...(cause.retryAfterSeconds !== undefined ? { retryAfterSeconds: cause.retryAfterSeconds } : {}),
        });
        return;
      }
      logger.error("web chat turn failed", { cause: String(cause) });
      res.status(500).json({ error: "Something went wrong handling that message." });
    }
  });

  return router;
}

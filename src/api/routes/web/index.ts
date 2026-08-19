import { Router } from "express";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createChatRouter } from "./chat.routes.js";
import { createClaimsRouter } from "./claims.routes.js";
import { createProfileRouter } from "./profile.routes.js";
import { createEmailConnectionsRouter } from "./email-connections.routes.js";

/** Composes every /api/web/* route into one router, mounted in server.ts
 * behind createWebSessionMiddleware() (the cookie) and the same public rate
 * limiter every other unauthenticated-by-login surface in this app uses. */
export function createWebApiRouter(model: BaseChatModel): Router {
  const router = Router();
  router.use(createChatRouter(model));
  router.use(createClaimsRouter());
  router.use(createProfileRouter());
  router.use(createEmailConnectionsRouter());
  return router;
}

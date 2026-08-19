import { Router, type Request, type Response } from "express";
import { OperatorTools } from "../../../operator/tools.js";
import { resolveWebIdentity } from "./resolve-web-user.js";

export function createEmailConnectionsRouter(): Router {
  const router = Router();

  router.get("/api/web/email-connections", async (req: Request, res: Response) => {
    const { userId, channelIdentityId } = await resolveWebIdentity(req);
    const tools = new OperatorTools(userId, channelIdentityId);
    res.json(await tools.dispatch("get_email_connection_status", {}));
  });

  return router;
}

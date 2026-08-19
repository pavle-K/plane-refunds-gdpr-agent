import { Router, type Request, type Response } from "express";
import { OperatorTools, ClaimAuthorizationError } from "../../../operator/tools.js";
import { ClaimRepo } from "../../../db/repositories/claim.repo.js";
import { resolveWebIdentity } from "./resolve-web-user.js";

/** Every route here is a thin wrapper around OperatorTools.dispatch — the
 * exact same dispatch surface the LLM tool-use loop calls (src/operator/
 * tools.ts) — so the web frontend's claim-detail view can read/act on a
 * claim without a round-trip through the LLM for things that don't need one
 * (viewing status, approving a draft, requesting a postal pack). */

async function respondOrNotFound(res: Response, run: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await run());
  } catch (cause) {
    if (cause instanceof ClaimAuthorizationError) {
      res.status(404).json({ error: "Claim not found." });
      return;
    }
    throw cause;
  }
}

export function createClaimsRouter(): Router {
  const router = Router();

  router.get("/api/web/claims", async (req: Request, res: Response) => {
    const { userId, channelIdentityId } = await resolveWebIdentity(req);
    const ownershipRows = await new ClaimRepo().findAllForUser(userId);
    const tools = new OperatorTools(userId, channelIdentityId);

    const claims = await Promise.all(
      ownershipRows.map(async (row) => {
        const detail = (await tools.dispatch("get_claim_status", { threadId: row.id })) as Record<string, unknown>;
        return {
          ...detail,
          bookingReference: row.bookingReference,
          createdAtUtc: row.createdAtUtc,
          updatedAtUtc: row.updatedAtUtc,
        };
      }),
    );
    claims.sort((a, b) => (b["updatedAtUtc"] as Date).getTime() - (a["updatedAtUtc"] as Date).getTime());

    res.json({ claims });
  });

  router.get("/api/web/claims/:id", async (req: Request, res: Response) => {
    const { userId, channelIdentityId } = await resolveWebIdentity(req);
    const tools = new OperatorTools(userId, channelIdentityId);
    await respondOrNotFound(res, () => tools.dispatch("get_claim_status", { threadId: req.params["id"] }));
  });

  router.post("/api/web/claims/:id/approval", async (req: Request, res: Response) => {
    const action = req.body?.["action"];
    if (action !== "approve" && action !== "edit" && action !== "decline") {
      res.status(400).json({ error: "action must be one of: approve, edit, decline." });
      return;
    }
    const editedText = req.body?.["editedText"];
    if (action === "edit" && typeof editedText !== "string") {
      res.status(400).json({ error: "editedText (the full replacement letter) is required for action 'edit'." });
      return;
    }

    const { userId, channelIdentityId } = await resolveWebIdentity(req);
    const tools = new OperatorTools(userId, channelIdentityId);
    await respondOrNotFound(res, () =>
      tools.dispatch("submit_approval_decision", {
        threadId: req.params["id"],
        action,
        ...(action === "edit" ? { editedText } : {}),
      }),
    );
  });

  router.post("/api/web/claims/:id/postal-pack", async (req: Request, res: Response) => {
    const { userId, channelIdentityId } = await resolveWebIdentity(req);
    const tools = new OperatorTools(userId, channelIdentityId);
    await respondOrNotFound(res, () => tools.dispatch("send_postal_pack", { threadId: req.params["id"] }));
  });

  return router;
}

import { Router, type Request, type Response } from "express";
import { OperatorTools } from "../../../operator/tools.js";
import { resolveWebIdentity } from "./resolve-web-user.js";

/** The subset of save_passenger_profile's input a web caller may set directly
 * — mirrors PassengerProfileToolInput (src/operator/tools.ts) exactly, since
 * this dispatches straight into the same handler the LLM tool call uses.
 * Whitelisted rather than spread wholesale: this is a public HTTP body, not a
 * zod-validated tool call (dispatch() bypasses TOOL_SCHEMAS' validation for
 * direct callers, same as every other route in this router). */
const PROFILE_FIELDS = [
  "fullName",
  "contactEmail",
  "phone",
  "addressLine1",
  "addressLine2",
  "city",
  "postalCode",
  "countryIsoCode",
  "iban",
  "bic",
] as const;

export function createProfileRouter(): Router {
  const router = Router();

  router.get("/api/web/profile", async (req: Request, res: Response) => {
    const { userId, channelIdentityId } = await resolveWebIdentity(req);
    const tools = new OperatorTools(userId, channelIdentityId);
    res.json(await tools.dispatch("get_passenger_profile", {}));
  });

  router.put("/api/web/profile", async (req: Request, res: Response) => {
    const { userId, channelIdentityId } = await resolveWebIdentity(req);
    const tools = new OperatorTools(userId, channelIdentityId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: Record<string, string> = {};
    for (const field of PROFILE_FIELDS) {
      const value = body[field];
      if (typeof value === "string" && value.trim().length > 0) {
        input[field] = value.trim();
      }
    }

    res.json(await tools.dispatch("save_passenger_profile", input));
  });

  return router;
}

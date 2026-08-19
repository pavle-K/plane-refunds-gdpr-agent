/**
 * Real Express router (web-session middleware + claims router) on an
 * ephemeral port, real Postgres, real HTTP requests, same conventions as
 * tests/integration/api/oauth-callback.route.test.ts. start_claim runs the
 * real graph but against fake provider deps (see
 * tests/integration/operator/claim-authorization.test.ts's doc comment —
 * NODE_ENV=test forces every provider factory to its fake regardless of real
 * keys in .env), so no live network calls happen here.
 *
 * Cookie handling is manual: Node's fetch has no browser-style cookie jar, so
 * each test captures the Set-Cookie from the first response and replays it
 * as a Cookie header on subsequent requests — this is also what proves the
 * whole point of web-session.ts, that the SAME cookie always resolves back
 * to the SAME channel identity/user.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { env } from "../../../src/config/env.js";
import { createWebSessionMiddleware, WEB_SESSION_COOKIE_NAME } from "../../../src/api/middleware/web-session.js";
import { createClaimsRouter } from "../../../src/api/routes/web/claims.routes.js";
import { ConversationRepo } from "../../../src/db/repositories/conversation.repo.js";
import { UserRepo } from "../../../src/db/repositories/user.repo.js";
import { OperatorTools } from "../../../src/operator/tools.js";

const canRun = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY);

const ONE_SEGMENT = { segments: [{ flightNumber: "BA123", date: "2024-06-15" }] };

function extractCookie(res: globalThis.Response): string {
  const raw = res.headers.get("set-cookie");
  const cookie = raw?.split(";")[0];
  if (!cookie?.startsWith(`${WEB_SESSION_COOKIE_NAME}=`)) {
    throw new Error(`Expected a ${WEB_SESSION_COOKIE_NAME} cookie, got: ${raw}`);
  }
  return cookie;
}

describe.skipIf(!canRun)("web claims routes (real Postgres, ephemeral Express server)", () => {
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(createWebSessionMiddleware(), createClaimsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Establishes a fresh session cookie and starts one claim under it
   * directly via OperatorTools (bypassing HTTP for the part this router
   * doesn't even expose — chat.routes.ts drives start_claim, not this
   * router), returning both so a test can hit the HTTP routes afterward. */
  async function seedClaimUnderNewSession() {
    const first = await fetch(`${baseUrl}/api/web/claims`);
    const cookie = extractCookie(first);
    const sessionId = cookie.split("=")[1]!;

    const channelIdentityId = await new ConversationRepo().getOrCreateIdentity("web", sessionId);
    const userId = await new UserRepo().getUserIdForChannelIdentity(channelIdentityId);
    if (!userId) throw new Error("expected a linked user");

    const started = (await new OperatorTools(userId, channelIdentityId).dispatch("start_claim", {
      ...ONE_SEGMENT,
      bookingReference: `WEB-TEST-${randomUUID()}`,
    })) as { threadId: string };

    return { cookie, threadId: started.threadId };
  }

  it("returns an empty list for a brand-new session", async () => {
    const res = await fetch(`${baseUrl}/api/web/claims`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claims: unknown[] };
    expect(body.claims).toEqual([]);
  });

  it("lists a claim started under this session, with bookingReference/timestamps merged onto the tool result", async () => {
    const { cookie, threadId } = await seedClaimUnderNewSession();

    const res = await fetch(`${baseUrl}/api/web/claims`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claims: Record<string, unknown>[] };
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0]?.["threadId"]).toBe(threadId);
    expect(body.claims[0]?.["bookingReference"]).toEqual(expect.stringContaining("WEB-TEST-"));
    expect(body.claims[0]?.["createdAtUtc"]).toBeTruthy();
    // getClaimStatus's booking field (added specifically for this frontend) survives the route.
    expect((body.claims[0]?.["booking"] as { segments: unknown[] } | undefined)?.segments).toHaveLength(1);
  });

  it("does not leak another session's claim into this session's list", async () => {
    await seedClaimUnderNewSession();
    const res = await fetch(`${baseUrl}/api/web/claims`); // fresh session, no cookie
    const body = (await res.json()) as { claims: unknown[] };
    expect(body.claims).toEqual([]);
  });

  it("GET /api/web/claims/:id returns the claim for its owner", async () => {
    const { cookie, threadId } = await seedClaimUnderNewSession();
    const res = await fetch(`${baseUrl}/api/web/claims/${threadId}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threadId: string };
    expect(body.threadId).toBe(threadId);
  });

  it("GET /api/web/claims/:id returns 404 for a claim owned by a different session", async () => {
    const { threadId } = await seedClaimUnderNewSession();
    const otherSession = await fetch(`${baseUrl}/api/web/claims`);
    const otherCookie = extractCookie(otherSession);

    const res = await fetch(`${baseUrl}/api/web/claims/${threadId}`, { headers: { Cookie: otherCookie } });
    expect(res.status).toBe(404);
  });

  it("GET /api/web/claims/:id returns 404 for an unknown id", async () => {
    const first = await fetch(`${baseUrl}/api/web/claims`);
    const cookie = extractCookie(first);
    const res = await fetch(`${baseUrl}/api/web/claims/claim-${randomUUID()}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it("POST .../approval rejects an invalid action before touching the claim", async () => {
    const { cookie, threadId } = await seedClaimUnderNewSession();
    const res = await fetch(`${baseUrl}/api/web/claims/${threadId}/approval`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "yolo" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST .../approval rejects action 'edit' without editedText", async () => {
    const { cookie, threadId } = await seedClaimUnderNewSession();
    const res = await fetch(`${baseUrl}/api/web/claims/${threadId}/approval`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST .../approval dispatches through to the graph for the owner and returns its real result", async () => {
    // BA123/2024-06-15 is unseeded in the fake flight-status adapter (see
    // tests/integration/operator/claim-authorization.test.ts's doc comment),
    // so this claim is ineligible and never actually reaches pending_approval
    // — this test is deliberately about the ROUTE (auth passes, dispatch
    // happens, the real dispatch result comes back verbatim), not about
    // approval-gate business logic, which belongs to the domain/node test
    // suites, not this thin routing layer.
    const { cookie, threadId } = await seedClaimUnderNewSession();
    const res = await fetch(`${baseUrl}/api/web/claims/${threadId}/approval`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "decline" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threadId: string; claimStatus: string };
    expect(body.threadId).toBe(threadId);
    expect(typeof body.claimStatus).toBe("string");
  });

  it("POST .../approval returns 404 for someone else's claim, without acting on it", async () => {
    const { threadId } = await seedClaimUnderNewSession();
    const otherSession = await fetch(`${baseUrl}/api/web/claims`);
    const otherCookie = extractCookie(otherSession);

    const res = await fetch(`${baseUrl}/api/web/claims/${threadId}/approval`, {
      method: "POST",
      headers: { Cookie: otherCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "decline" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST .../postal-pack returns 404 for a claim id that doesn't belong to this session", async () => {
    const res = await fetch(`${baseUrl}/api/web/claims/claim-${randomUUID()}/postal-pack`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

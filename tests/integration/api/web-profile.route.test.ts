/**
 * Real Express router (web-session middleware + profile router) on an
 * ephemeral port, real Postgres, real HTTP requests — same conventions as
 * web-claims.route.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { env } from "../../../src/config/env.js";
import { createWebSessionMiddleware, WEB_SESSION_COOKIE_NAME } from "../../../src/api/middleware/web-session.js";
import { createProfileRouter } from "../../../src/api/routes/web/profile.routes.js";

const canRun = Boolean(env.DATABASE_URL && env.TOKEN_ENCRYPTION_KEY);

function extractCookie(res: globalThis.Response): string {
  const raw = res.headers.get("set-cookie");
  const cookie = raw?.split(";")[0];
  if (!cookie?.startsWith(`${WEB_SESSION_COOKIE_NAME}=`)) {
    throw new Error(`Expected a ${WEB_SESSION_COOKIE_NAME} cookie, got: ${raw}`);
  }
  return cookie;
}

describe.skipIf(!canRun)("web profile routes (real Postgres, ephemeral Express server)", () => {
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(createWebSessionMiddleware(), createProfileRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function newSessionCookie(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/web/profile`);
    return extractCookie(res);
  }

  it("reports no saved profile for a brand-new session", async () => {
    const cookie = await newSessionCookie();
    const res = await fetch(`${baseUrl}/api/web/profile`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved: boolean };
    expect(body.saved).toBe(false);
  });

  it("saves a profile and reflects it back on the next GET", async () => {
    const cookie = await newSessionCookie();

    const putRes = await fetch(`${baseUrl}/api/web/profile`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Ada Lovelace", contactEmail: "ada@example.com", city: "London" }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { saved: boolean; fullName: string; city: string | null };
    expect(putBody.saved).toBe(true);
    expect(putBody.fullName).toBe("Ada Lovelace");
    expect(putBody.city).toBe("London");

    const getRes = await fetch(`${baseUrl}/api/web/profile`, { headers: { Cookie: cookie } });
    const getBody = (await getRes.json()) as { fullName: string; contactEmail: string };
    expect(getBody.fullName).toBe("Ada Lovelace");
    expect(getBody.contactEmail).toBe("ada@example.com");
  });

  it("merges a partial update onto the existing profile instead of clearing unset fields", async () => {
    const cookie = await newSessionCookie();
    await fetch(`${baseUrl}/api/web/profile`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Grace Hopper", contactEmail: "grace@example.com", phone: "+1-555-0100" }),
    });

    const putRes = await fetch(`${baseUrl}/api/web/profile`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ city: "Arlington" }),
    });
    const body = (await putRes.json()) as { fullName: string; phone: string | null; city: string | null };
    expect(body.fullName).toBe("Grace Hopper");
    expect(body.phone).toBe("+1-555-0100");
    expect(body.city).toBe("Arlington");
  });

  it("ignores blank/whitespace-only fields rather than saving them", async () => {
    const cookie = await newSessionCookie();
    const res = await fetch(`${baseUrl}/api/web/profile`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "  ", contactEmail: "person@example.com" }),
    });
    // fullName was blank and existing was none — save_passenger_profile
    // requires a full name the first time, so this should report the error
    // rather than silently saving an empty name.
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it("never returns a raw IBAN/BIC — only whether one is on file", async () => {
    const cookie = await newSessionCookie();
    await fetch(`${baseUrl}/api/web/profile`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Alan Turing",
        contactEmail: "alan@example.com",
        iban: "GB29NWBK60161331926819",
        bic: "NWBKGB2L",
      }),
    });

    const res = await fetch(`${baseUrl}/api/web/profile`, { headers: { Cookie: cookie } });
    const text = await res.text();
    expect(text).not.toContain("GB29NWBK60161331926819");
    expect(text).not.toContain("NWBKGB2L");
    const body = JSON.parse(text) as { hasIban: boolean; hasBic: boolean };
    expect(body.hasIban).toBe(true);
    expect(body.hasBic).toBe(true);
  });

  it("keeps two sessions' profiles isolated from each other", async () => {
    const cookieA = await newSessionCookie();
    const cookieB = await newSessionCookie();

    await fetch(`${baseUrl}/api/web/profile`, {
      method: "PUT",
      headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Session A", contactEmail: "a@example.com" }),
    });

    const resB = await fetch(`${baseUrl}/api/web/profile`, { headers: { Cookie: cookieB } });
    const bodyB = (await resB.json()) as { saved: boolean };
    expect(bodyB.saved).toBe(false);
  });
});

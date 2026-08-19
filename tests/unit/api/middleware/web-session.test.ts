/**
 * Same NODE_ENV/WEB_APP_ORIGIN-controlled dynamic-reimport approach as
 * tests/unit/config/env.test.ts, since createWebSessionMiddleware's
 * production-only Origin check depends on env.ts's module-level singleton —
 * this suite needs to exercise both a dev-like and a production-like
 * instance of it in the same run, which a single static import can't do.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";

vi.mock("dotenv", () => ({ config: vi.fn() }));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, DATABASE_URL: "postgresql://user:pass@host:5432/db" };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function buildApp(): Promise<{ app: Express; cookieName: string }> {
  const { createWebSessionMiddleware, WEB_SESSION_COOKIE_NAME } = await import(
    "../../../../src/api/middleware/web-session.js"
  );
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(createWebSessionMiddleware());
  app.get("/api/web/probe", (req, res) => res.json({ webSessionId: req.webSessionId ?? null }));
  app.post("/api/web/probe", (req, res) => res.json({ webSessionId: req.webSessionId ?? null }));
  app.get("/healthz", (_req, res) => res.sendStatus(200));
  return { app, cookieName: WEB_SESSION_COOKIE_NAME };
}

async function withServer<T>(app: Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = (server.address() as AddressInfo);
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function extractCookie(res: Response, name: string): string | undefined {
  const raw = res.headers.get("set-cookie");
  if (!raw) return undefined;
  const match = raw.split(";")[0];
  return match?.startsWith(`${name}=`) ? match : undefined;
}

describe("createWebSessionMiddleware", () => {
  it("leaves requests outside /api/web/* untouched", async () => {
    process.env["NODE_ENV"] = "development";
    const { app } = await buildApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  });

  it("issues an httpOnly, path-scoped session cookie on first visit", async () => {
    process.env["NODE_ENV"] = "development";
    const { app, cookieName } = await buildApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/web/probe`);
      const raw = res.headers.get("set-cookie");
      expect(raw).toBeTruthy();
      expect(raw).toContain(`${cookieName}=`);
      expect(raw).toContain("HttpOnly");
      expect(raw).toContain("Path=/api/web");
      expect(raw).toContain("SameSite=Lax");

      const body = (await res.json()) as { webSessionId: string | null };
      expect(body.webSessionId).toBeTruthy();
    });
  });

  it("reuses the same session id across requests carrying the cookie", async () => {
    process.env["NODE_ENV"] = "development";
    const { app } = await buildApp();
    await withServer(app, async (baseUrl) => {
      const first = await fetch(`${baseUrl}/api/web/probe`);
      const cookie = extractCookie(first, "prg_web_session");
      expect(cookie).toBeTruthy();
      const firstBody = (await first.json()) as { webSessionId: string };

      const second = await fetch(`${baseUrl}/api/web/probe`, { headers: { Cookie: cookie! } });
      expect(second.headers.get("set-cookie")).toBeNull(); // no re-issue once already present
      const secondBody = (await second.json()) as { webSessionId: string };

      expect(secondBody.webSessionId).toBe(firstBody.webSessionId);
    });
  });

  it("does not enforce the Origin check outside production, even with a mismatched Origin", async () => {
    process.env["NODE_ENV"] = "development";
    process.env["WEB_APP_ORIGIN"] = "https://claims.example.com";
    const { app } = await buildApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/web/probe`, {
        method: "POST",
        headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
    });
  });

  it("rejects a state-changing production request whose Origin doesn't match WEB_APP_ORIGIN", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["WEB_APP_ORIGIN"] = "https://claims.example.com";
    process.env["TELEGRAM_WEBHOOK_SECRET"] = "secret";
    process.env["PUBLIC_URL"] = "https://claims.example.com";
    process.env["TOKEN_ENCRYPTION_KEY"] = Buffer.alloc(32, 1).toString("base64");
    const { app } = await buildApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/web/probe`, {
        method: "POST",
        headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    });
  });

  it("allows a state-changing production request whose Origin matches WEB_APP_ORIGIN", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["WEB_APP_ORIGIN"] = "https://claims.example.com";
    process.env["TELEGRAM_WEBHOOK_SECRET"] = "secret";
    process.env["PUBLIC_URL"] = "https://claims.example.com";
    process.env["TOKEN_ENCRYPTION_KEY"] = Buffer.alloc(32, 1).toString("base64");
    const { app } = await buildApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/web/probe`, {
        method: "POST",
        headers: { Origin: "https://claims.example.com", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
    });
  });

  it("allows a production request with no Origin header at all (non-browser clients)", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["WEB_APP_ORIGIN"] = "https://claims.example.com";
    process.env["TELEGRAM_WEBHOOK_SECRET"] = "secret";
    process.env["PUBLIC_URL"] = "https://claims.example.com";
    process.env["TOKEN_ENCRYPTION_KEY"] = Buffer.alloc(32, 1).toString("base64");
    const { app } = await buildApp();
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/web/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
    });
  });

  it("falls back to PUBLIC_URL when WEB_APP_ORIGIN is unset (same-origin production topology)", async () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["WEB_APP_ORIGIN"];
    process.env["TELEGRAM_WEBHOOK_SECRET"] = "secret";
    process.env["PUBLIC_URL"] = "https://claims.example.com";
    process.env["TOKEN_ENCRYPTION_KEY"] = Buffer.alloc(32, 1).toString("base64");
    const { app } = await buildApp();
    await withServer(app, async (baseUrl) => {
      const mismatched = await fetch(`${baseUrl}/api/web/probe`, {
        method: "POST",
        headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(mismatched.status).toBe(403);

      const matching = await fetch(`${baseUrl}/api/web/probe`, {
        method: "POST",
        headers: { Origin: "https://claims.example.com", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(matching.status).toBe(200);
    });
  });
});

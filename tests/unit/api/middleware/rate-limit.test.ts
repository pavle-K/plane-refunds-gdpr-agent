import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { createPublicEndpointRateLimiter } from "../../../../src/api/middleware/rate-limit.js";

describe("createPublicEndpointRateLimiter", () => {
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = express();
    // A low limit so the test doesn't need to fire dozens of requests.
    app.use(createPublicEndpointRateLimiter(3));
    app.get("/probe", (_req, res) => res.sendStatus(200));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("allows requests under the limit and blocks once it's exceeded", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${baseUrl}/probe`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });
});

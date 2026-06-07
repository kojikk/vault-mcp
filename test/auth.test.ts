import { describe, it, expect } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { makeAuthMiddleware } from "../src/auth.js";
import type { Config } from "../src/config.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    vaultRoot: "/tmp/x",
    token: "a".repeat(40),
    bindHost: "127.0.0.1",
    port: 0,
    bodyLimit: "1mb",
    rateLimit: { windowMs: 60000, max: 1000, lockoutThreshold: 3, lockoutMs: 60000 },
    serverTimeoutMs: 30000,
    logFile: null,
    logLevel: "error",
    gitAuthorName: "t",
    gitAuthorEmail: "t@t",
    ...overrides,
  };
}

async function withServer(config: Config, fn: (base: string) => Promise<void>) {
  const app = express();
  app.set("trust proxy", "loopback");
  app.post("/mcp", makeAuthMiddleware(config, silent), express.json(), (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe("auth middleware (C-4)", () => {
  it("rejects a request with no Authorization header", async () => {
    await withServer(testConfig(), async (base) => {
      const res = await fetch(`${base}/mcp`, { method: "POST" });
      expect(res.status).toBe(401);
    });
  });

  it("rejects a wrong token", async () => {
    await withServer(testConfig(), async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token-value-still-long-enough" },
      });
      expect(res.status).toBe(401);
    });
  });

  it("accepts the correct token", async () => {
    const config = testConfig();
    await withServer(config, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
    });
  });

  it("does NOT accept the token via query string", async () => {
    const config = testConfig();
    await withServer(config, async (base) => {
      const res = await fetch(`${base}/mcp?token=${config.token}`, { method: "POST" });
      expect(res.status).toBe(401);
    });
  });

  it("locks out after the failure threshold", async () => {
    const config = testConfig({ rateLimit: { windowMs: 60000, max: 1000, lockoutThreshold: 3, lockoutMs: 60000 } });
    await withServer(config, async (base) => {
      for (let i = 0; i < 3; i++) {
        await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer nope-nope-nope-nope-nope-nope" } });
      }
      // Now even the correct token is locked out for this IP.
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}` },
      });
      expect(res.status).toBe(429);
    });
  });
});

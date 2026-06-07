import express from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { makeAuthMiddleware } from "./auth.js";

/**
 * HTTP transport for the MCP. Hardening applied here:
 *  - Binds to loopback by default (C-8); external reach is only via Caddy.
 *  - Rate limiting + auth run BEFORE the JSON body parser (M-5): no pre-auth parser surface.
 *  - Explicit body size limit and server timeouts (M-5).
 *  - Stateless: a fresh MCP server + transport per request, so there is no cross-request
 *    session state to confuse or leak (defense in depth for a single-user deployment).
 */
export function startServer(opts: {
  config: Config;
  log: Logger;
  makeServer: () => McpServer;
}): Server {
  const { config, log, makeServer } = opts;
  const app = express();

  app.disable("x-powered-by");
  // Caddy is the only proxy and sits on loopback.
  app.set("trust proxy", "loopback");

  const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "rate limit exceeded" },
  });

  const auth = makeAuthMiddleware(config, log);

  // Liveness probe — unauthenticated, returns nothing sensitive.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Order matters: rate-limit -> auth -> body parse -> handler.
  app.post(
    "/mcp",
    limiter,
    auth,
    express.json({ limit: config.bodyLimit }),
    async (req, res) => {
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      res.on("close", () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        log.error("mcp_request_error", { reason: (err as Error).message });
        if (!res.headersSent) {
          res.status(500).json({ error: "internal error" });
        }
      }
    },
  );

  // Stateless server does not support server-initiated streams or session deletion.
  const reject405 = (_req: express.Request, res: express.Response) => {
    res.status(405).json({ error: "method not allowed" });
  };
  app.get("/mcp", limiter, auth, reject405);
  app.delete("/mcp", limiter, auth, reject405);

  const httpServer = app.listen(config.port, config.bindHost, () => {
    log.info("listening", { host: config.bindHost, port: config.port, requestId: randomUUID().slice(0, 8) });
  });

  // Server timeouts (M-5): bound slow-loris / hung connections.
  httpServer.requestTimeout = config.serverTimeoutMs;
  httpServer.headersTimeout = Math.min(config.serverTimeoutMs, 15_000);
  httpServer.keepAliveTimeout = 5_000;

  return httpServer;
}

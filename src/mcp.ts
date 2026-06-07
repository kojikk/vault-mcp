import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/context.js";
import { IdempotencyLedger } from "./tools/idempotency.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerStructuralTools } from "./tools/structural.js";

/**
 * Build a fresh MCP server with the full tool surface (least privilege: read, additive,
 * structural, soft-delete — no hard delete, no shell, no network). The transport creates one
 * of these per request (stateless), but the ledger is shared so idempotency survives across
 * requests within a process lifetime.
 */
export function makeServerFactory(ctx: ToolContext): () => McpServer {
  const ledger = new IdempotencyLedger();
  return () => {
    const server = new McpServer(
      { name: "vault-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerReadTools(server, ctx);
    registerWriteTools(server, ctx, ledger);
    registerStructuralTools(server, ctx);
    return server;
  };
}

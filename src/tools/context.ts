import type { VaultCore } from "../core/vault-core.js";
import type { GraphIndex } from "../core/graph/assemble.js";
import type { Logger } from "../logger.js";
import { isCoreError } from "../core/errors.js";

/** Shared dependencies handed to every tool handler. */
export interface ToolContext {
  core: VaultCore;
  /** Process-lifetime graph index (invalidated by the core's mutation listener). */
  graph: GraphIndex;
  log: Logger;
}

export interface ToolResult {
  // Index signature required by the MCP SDK's tool-handler return type.
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Map a thrown error to a tool result. CoreErrors carry a safe, non-sensitive message and
 * a stable code; anything else is reported generically so internals never leak to callers.
 */
export function mapError(err: unknown, log: Logger, op: string): ToolResult {
  if (isCoreError(err)) {
    log.info("tool_rejected", { op, code: err.code });
    return errorResult(`${err.code}: ${err.message}`);
  }
  log.error("tool_error", { op, reason: (err as Error).message });
  return errorResult("internal error");
}

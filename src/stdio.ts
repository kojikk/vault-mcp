import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./logger.js";
import { VaultCore } from "./core/vault-core.js";
import { makeServerFactory } from "./mcp.js";

/**
 * Local stdio entrypoint for Claude Desktop.
 *
 * Claude Desktop spawns this process and speaks MCP over stdin/stdout, so there is
 * no open port, no network, and no Bearer auth to carry — the transport is the pipe
 * between two local processes the OS already isolates. The deadly-triad defenses are
 * unchanged: every filesystem operation still goes through vault-core (realpath
 * confinement, extension allowlist, reserved-dir denial, soft-delete only), there is
 * no egress, and the only child process is ripgrep via execFile with an arg array.
 *
 * config.ts requires MCP_TOKEN (>=32 chars) because the HTTP entrypoint authenticates
 * with it. The stdio path never authenticates, so we synthesize an ephemeral token that
 * is generated fresh each run and never used by anything.
 */
async function main(): Promise<void> {
  if (!process.env.MCP_TOKEN && !process.env.MCP_TOKEN_FILE) {
    process.env.MCP_TOKEN = randomBytes(32).toString("hex");
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[config] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Never let operational logs land on stdout (the protocol channel).
  const log = createLogger({ level: config.logLevel, file: config.logFile });

  const core = new VaultCore({
    vaultRoot: config.vaultRoot,
    git: { name: config.gitAuthorName, email: config.gitAuthorEmail },
    logger: log,
  });
  await core.init();

  const makeServer = makeServerFactory({ core, log });
  const server = makeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info("ready", { transport: "stdio", vaultRoot: core.root });
}

main().catch((err) => {
  process.stderr.write(`[fatal] ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

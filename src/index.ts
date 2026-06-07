import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./logger.js";
import { VaultCore } from "./core/vault-core.js";
import { makeServerFactory } from "./mcp.js";
import { startServer } from "./server.js";

/**
 * Entrypoint. Fail-closed: any configuration problem aborts startup with a clear message
 * and a non-zero exit, before the server ever binds a port (lessons M-1/M-2).
 */
async function main(): Promise<void> {
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

  const log = createLogger({ level: config.logLevel, file: config.logFile });

  const core = new VaultCore({
    vaultRoot: config.vaultRoot,
    git: { name: config.gitAuthorName, email: config.gitAuthorEmail },
    logger: log,
  });
  await core.init();

  const makeServer = makeServerFactory({ core, log });
  const httpServer = startServer({ config, log, makeServer });

  const shutdown = (signal: string) => {
    log.info("shutdown", { signal });
    httpServer.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  log.info("ready", { vaultRoot: core.root });
}

main().catch((err) => {
  process.stderr.write(`[fatal] ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

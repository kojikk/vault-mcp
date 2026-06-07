import { realpathSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";

/**
 * Fail-closed configuration.
 *
 * Lessons applied:
 *  - M-1: every parse is guarded; a bad value produces a clear error, never a crash-at-use.
 *  - M-2: a missing/invalid VAULT_ROOT aborts startup. There is no "no restriction" default.
 *  - L-2: booleans are normalized (1/true/yes/on), not compared strictly to the string 'true'.
 *  - C-3: secrets are read from a file (Docker secret) when *_FILE is set, never baked in.
 */

export interface Config {
  /** realpath(VAULT_ROOT) — the single confinement boundary. */
  readonly vaultRoot: string;
  /** Bearer token, compared in constant time. Never logged. */
  readonly token: string;
  readonly bindHost: string;
  readonly port: number;
  /** Max request body size for the MCP endpoint, e.g. "1mb". */
  readonly bodyLimit: string;
  readonly rateLimit: {
    readonly windowMs: number;
    readonly max: number;
    /** Consecutive auth failures from one IP before a temporary lockout. */
    readonly lockoutThreshold: number;
    readonly lockoutMs: number;
  };
  readonly serverTimeoutMs: number;
  /** Path to the sanitized operational log, or null for stderr only. */
  readonly logFile: string | null;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  /** Git author identity for local commits (no network involved). */
  readonly gitAuthorName: string;
  readonly gitAuthorEmail: string;
}

class ConfigError extends Error {}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off", ""]);

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  throw new ConfigError(`expected a boolean (1/true/yes/on or 0/false/no/off), got: ${JSON.stringify(raw)}`);
}

function int(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Read a secret either directly from VAR or from a file referenced by VAR_FILE
 * (the Docker secrets convention). The file form is preferred and takes precedence.
 */
function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const fileVar = env[`${name}_FILE`];
  if (fileVar && fileVar.trim() !== "") {
    try {
      return readFileSync(fileVar, "utf8").trim();
    } catch (err) {
      throw new ConfigError(`${name}_FILE is set but could not be read (${fileVar}): ${(err as Error).message}`);
    }
  }
  const direct = env[name];
  return direct === undefined ? undefined : direct.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // --- VAULT_ROOT: the confinement boundary. Must exist and be a directory. ---
  const rawRoot = env.VAULT_ROOT?.trim();
  if (!rawRoot) {
    throw new ConfigError("VAULT_ROOT is required. Refusing to start without a vault boundary (fail-closed).");
  }
  let vaultRoot: string;
  try {
    vaultRoot = realpathSync(rawRoot);
  } catch (err) {
    throw new ConfigError(`VAULT_ROOT does not resolve to a real path (${rawRoot}): ${(err as Error).message}`);
  }
  let st;
  try {
    st = statSync(vaultRoot);
  } catch (err) {
    throw new ConfigError(`VAULT_ROOT cannot be stat'd (${vaultRoot}): ${(err as Error).message}`);
  }
  if (!st.isDirectory()) {
    throw new ConfigError(`VAULT_ROOT must be a directory, got a non-directory: ${vaultRoot}`);
  }

  // --- MCP_TOKEN: required, minimum entropy enforced. ---
  const token = secret(env, "MCP_TOKEN");
  if (!token) {
    throw new ConfigError("MCP_TOKEN (or MCP_TOKEN_FILE) is required. Generate with: openssl rand -hex 32");
  }
  if (token.length < 32) {
    throw new ConfigError("MCP_TOKEN is too short (<32 chars). Generate with: openssl rand -hex 32");
  }

  const bindHost = env.BIND_HOST?.trim() || "127.0.0.1";
  const port = int(env.PORT, 8787, "PORT");
  const bodyLimit = env.BODY_LIMIT?.trim() || "1mb";

  const rateLimit = {
    windowMs: int(env.RATE_LIMIT_WINDOW_MS, 60_000, "RATE_LIMIT_WINDOW_MS"),
    max: int(env.RATE_LIMIT_MAX, 120, "RATE_LIMIT_MAX"),
    lockoutThreshold: int(env.AUTH_LOCKOUT_THRESHOLD, 10, "AUTH_LOCKOUT_THRESHOLD"),
    lockoutMs: int(env.AUTH_LOCKOUT_MS, 15 * 60_000, "AUTH_LOCKOUT_MS"),
  } as const;

  const serverTimeoutMs = int(env.SERVER_TIMEOUT_MS, 30_000, "SERVER_TIMEOUT_MS");

  const logFile = env.LOG_FILE?.trim() ? env.LOG_FILE.trim() : null;
  const rawLevel = (env.LOG_LEVEL?.trim().toLowerCase() || "info") as Config["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(rawLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of debug|info|warn|error, got: ${rawLevel}`);
  }

  // Touch a known boolean so misconfig surfaces at startup, not first use (M-1).
  bool(env.LOG_PRETTY, false);

  return {
    vaultRoot,
    token,
    bindHost,
    port,
    bodyLimit,
    rateLimit,
    serverTimeoutMs,
    logFile,
    logLevel: rawLevel,
    gitAuthorName: env.GIT_AUTHOR_NAME?.trim() || "vault-mcp",
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL?.trim() || "vault-mcp@localhost",
  };
}

export { ConfigError };

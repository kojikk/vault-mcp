import {
  openSync,
  writeSync,
  closeSync,
  fstatSync,
  renameSync,
  constants as fsConstants,
} from "node:fs";

/**
 * Structured operational logger.
 *
 * Lesson H-5: server logs must NOT contain the token or note bodies (the vault is
 * personal data). We enforce this two ways:
 *   1. An allowlist of forbidden keys is stripped from every payload.
 *   2. Callers are expected to pass metadata only (paths, op names, counts) — never
 *      file contents. The strip is a backstop, not the primary control.
 *
 * The log file is opened append-only with mode 0600 and rotated by size.
 */

type Level = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys that must never appear in logs, regardless of caller intent. */
const FORBIDDEN_KEYS = new Set([
  "token",
  "authorization",
  "auth",
  "mcp_token",
  "secret",
  "password",
  "content",
  "body",
  "text",
  "data",
  "note",
  "frontmatter",
]);

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MiB before rotation

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

function sanitize(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
      out[k] = "[redacted]";
      continue;
    }
    // Defense in depth: never serialize large strings into logs.
    if (typeof v === "string" && v.length > 256) {
      out[k] = `[string:${v.length} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createLogger(opts: {
  level: Level;
  file: string | null;
}): Logger {
  const threshold = LEVEL_ORDER[opts.level];
  let fd: number | null = null;

  if (opts.file) {
    // O_APPEND + restrictive mode. The mode only applies on creation.
    fd = openSync(opts.file, fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_APPEND, 0o600);
  }

  function rotateIfNeeded(path: string, handle: number): number {
    try {
      const { size } = fstatSync(handle);
      if (size < MAX_LOG_BYTES) return handle;
      closeSync(handle);
      renameSync(path, `${path}.1`);
      return openSync(path, fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_APPEND, 0o600);
    } catch {
      return handle;
    }
  }

  function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...sanitize(meta),
    });
    // Operational logs go to stderr (stdout is reserved for protocol on stdio transports).
    process.stderr.write(record + "\n");
    if (opts.file && fd !== null) {
      fd = rotateIfNeeded(opts.file, fd);
      try {
        writeSync(fd, record + "\n");
      } catch {
        /* never let logging failure crash a request */
      }
    }
  }

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}

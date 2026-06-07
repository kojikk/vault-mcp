import {
  writeFileSync,
  renameSync,
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Atomic file write: write to a temp file in the same directory, fsync, then rename
 * over the destination. rename(2) within a filesystem is atomic, so a reader (Obsidian
 * or another MCP op) never observes a partially written file. This is also our main
 * mitigation for the documented human-edits-same-file race (best-effort concurrency).
 */
export function atomicWrite(absPath: string, contents: string): void {
  const dir = path.dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o644 });
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, absPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
    throw err;
  }
}

/** Ensure a directory exists inside the vault (parents created as needed). */
export function ensureDir(absPath: string): void {
  mkdirSync(absPath, { recursive: true });
}

import { realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { CoreError } from "./errors.js";

/**
 * Path confinement — the central control of the security model (lessons M-3, H-1, M-4).
 *
 * Every filesystem path supplied from outside the core flows through here. There is no
 * other way to turn a caller-supplied relative path into an absolute one.
 *
 *  - M-3 (symlink escape): the longest existing prefix of the target is realpath'd and
 *    must remain within realpath(VAULT_ROOT). A symlink pointing outside the vault is
 *    rejected, even if the lexical path looked contained.
 *  - H-1 (allowlist, not blocklist): writeable files must carry an allowlisted extension.
 *  - M-4 (reserved areas): writes into .git/ .obsidian/ .trash/ via caller paths are denied;
 *    the trash is only ever written by the core's own soft_delete transaction.
 */

/** Extensions a caller may create/write. Service files (_index.md etc.) are .md. */
export const WRITABLE_EXTENSIONS = new Set([".md", ".canvas"]);

/** Directory names that callers may never write into directly. */
export const RESERVED_DIRS = new Set([".git", ".obsidian", ".trash"]);

const WIN = process.platform === "win32";

/** True if `p` is the root itself or strictly inside it. Separator/case aware. */
export function isWithin(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === "..") return false;
  return !rel.startsWith(".." + path.sep);
}

function assertSane(rel: string): void {
  if (rel.includes("\0")) {
    throw new CoreError("NULL_BYTE", "path contains a null byte");
  }
  if (path.isAbsolute(rel)) {
    throw new CoreError("OUTSIDE_VAULT", "absolute paths are not allowed; supply a vault-relative path");
  }
}

/** Realpath the longest existing ancestor of `candidate` and assert it stays in root. */
function assertRealWithin(root: string, candidate: string): void {
  let cur = candidate;
  // Walk up until we hit something that exists (or the filesystem root).
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  let real: string;
  try {
    real = realpathSync(cur);
  } catch {
    // If even the root cannot be resolved, treat as outside.
    throw new CoreError("OUTSIDE_VAULT", "path could not be resolved to a real location");
  }
  if (!isWithin(root, real)) {
    throw new CoreError("OUTSIDE_VAULT", "path resolves outside the vault (symlink escape denied)");
  }
}

/** True if any path segment is a reserved directory name. */
function touchesReserved(rel: string): boolean {
  return rel
    .split(/[\\/]+/)
    .some((seg) => RESERVED_DIRS.has(WIN ? seg.toLowerCase() : seg));
}

export class VaultPaths {
  /** realpath(VAULT_ROOT), established once at startup. */
  readonly root: string;

  constructor(realVaultRoot: string) {
    this.root = realVaultRoot;
  }

  /**
   * Resolve a vault-relative path for READING. The target must exist and resolve
   * (after symlinks) to a location within the vault.
   */
  resolveExisting(rel: string): string {
    assertSane(rel);
    const candidate = path.resolve(this.root, rel);
    if (!isWithin(this.root, candidate)) {
      throw new CoreError("OUTSIDE_VAULT", "path escapes the vault");
    }
    assertRealWithin(this.root, candidate);
    if (!existsSync(candidate)) {
      throw new CoreError("NOT_FOUND", "no such path in the vault");
    }
    return candidate;
  }

  /**
   * Resolve a vault-relative FILE path for WRITING. Enforces extension allowlist and
   * reserved-directory denial. Does not require the file to pre-exist.
   */
  resolveForWrite(rel: string): string {
    assertSane(rel);
    const candidate = path.resolve(this.root, rel);
    if (!isWithin(this.root, candidate)) {
      throw new CoreError("OUTSIDE_VAULT", "path escapes the vault");
    }
    const ext = path.extname(candidate).toLowerCase();
    if (!WRITABLE_EXTENSIONS.has(ext)) {
      throw new CoreError("BAD_EXTENSION", `only ${[...WRITABLE_EXTENSIONS].join(", ")} files may be written`);
    }
    const relFromRoot = path.relative(this.root, candidate);
    if (touchesReserved(relFromRoot)) {
      throw new CoreError("RESERVED_PATH", "writing into .git/.obsidian/.trash is not allowed");
    }
    assertRealWithin(this.root, candidate);
    return candidate;
  }

  /**
   * Resolve a vault-relative DIRECTORY path (for node creation / moves). No extension
   * check; reserved directories are still denied.
   */
  resolveDir(rel: string): string {
    assertSane(rel);
    const candidate = path.resolve(this.root, rel);
    if (!isWithin(this.root, candidate)) {
      throw new CoreError("OUTSIDE_VAULT", "path escapes the vault");
    }
    const relFromRoot = path.relative(this.root, candidate);
    if (relFromRoot !== "" && touchesReserved(relFromRoot)) {
      throw new CoreError("RESERVED_PATH", "operating on .git/.obsidian/.trash is not allowed");
    }
    assertRealWithin(this.root, candidate);
    return candidate;
  }

  /** Vault-relative POSIX-style display path for a resolved absolute path. */
  toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }
}

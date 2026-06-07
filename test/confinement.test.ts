import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VaultPaths } from "../src/core/paths.js";
import { CoreError } from "../src/core/errors.js";

/**
 * These tests are the security gate for Phase 0. The path layer is the central control
 * of the whole model (lesson M-3): if confinement holds, "arbitrary write" and
 * "symlink escape" are off the table regardless of what a tool does above it.
 */

let vaultRoot: string;
let outside: string;
let vp: VaultPaths;

beforeEach(() => {
  // realpath both so symlinked tmpdirs (common on macOS) don't create false negatives.
  vaultRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "vault-")));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "outside-")));
  vp = new VaultPaths(vaultRoot);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CoreError) return e.code;
    throw e;
  }
  throw new Error("expected a CoreError but none was thrown");
}

describe("write path confinement", () => {
  it("accepts a normal vault-relative markdown path", () => {
    const abs = vp.resolveForWrite("Veha-A/_home.md");
    expect(abs.startsWith(vaultRoot)).toBe(true);
  });

  it("accepts .canvas", () => {
    expect(() => vp.resolveForWrite("board.canvas")).not.toThrow();
  });

  it("rejects parent traversal", () => {
    expect(code(() => vp.resolveForWrite("../outside.md"))).toBe("OUTSIDE_VAULT");
    expect(code(() => vp.resolveForWrite("a/../../escape.md"))).toBe("OUTSIDE_VAULT");
  });

  it("rejects absolute paths", () => {
    const abs = path.join(outside, "x.md");
    expect(code(() => vp.resolveForWrite(abs))).toBe("OUTSIDE_VAULT");
  });

  it("rejects non-allowlisted extensions", () => {
    expect(code(() => vp.resolveForWrite("notes.txt"))).toBe("BAD_EXTENSION");
    expect(code(() => vp.resolveForWrite("a/b.json"))).toBe("BAD_EXTENSION");
    expect(code(() => vp.resolveForWrite("script.sh"))).toBe("BAD_EXTENSION");
  });

  it("rejects writes into reserved directories", () => {
    expect(code(() => vp.resolveForWrite(".git/hooks/post.md"))).toBe("RESERVED_PATH");
    expect(code(() => vp.resolveForWrite(".obsidian/app.md"))).toBe("RESERVED_PATH");
    expect(code(() => vp.resolveForWrite(".trash/old.md"))).toBe("RESERVED_PATH");
  });

  it("rejects null bytes", () => {
    expect(code(() => vp.resolveForWrite("a\u0000b.md"))).toBe("NULL_BYTE");
  });
});

describe("read path confinement", () => {
  it("resolves an existing file", () => {
    writeFileSync(path.join(vaultRoot, "note.md"), "hi");
    expect(() => vp.resolveExisting("note.md")).not.toThrow();
  });

  it("rejects a non-existent file as NOT_FOUND", () => {
    expect(code(() => vp.resolveExisting("nope.md"))).toBe("NOT_FOUND");
  });

  it("rejects traversal on read", () => {
    expect(code(() => vp.resolveExisting("../secret"))).toBe("OUTSIDE_VAULT");
  });
});

describe("symlink escape (M-3)", () => {
  it("denies a path resolving outside via a symlink", () => {
    const secret = path.join(outside, "secret.md");
    writeFileSync(secret, "TOP SECRET");
    let linkable = true;
    try {
      // A symlink inside the vault pointing at the outside directory.
      symlinkSync(outside, path.join(vaultRoot, "link"), "junction");
    } catch {
      try {
        symlinkSync(outside, path.join(vaultRoot, "link"));
      } catch {
        linkable = false; // unprivileged Windows without developer mode
      }
    }
    if (!linkable) {
      return; // skip where the OS forbids symlink creation
    }
    // Reading through the symlink must be denied even though it's lexically inside.
    expect(code(() => vp.resolveExisting("link/secret.md"))).toBe("OUTSIDE_VAULT");
    expect(code(() => vp.resolveForWrite("link/evil.md"))).toBe("OUTSIDE_VAULT");
  });
});

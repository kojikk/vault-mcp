import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { VaultPaths } from "./paths.js";
import { WriteGate } from "./lock.js";
import { VaultGit, type GitIdentity } from "./git.js";
import { atomicWrite } from "./atomic.js";
import { CoreError } from "./errors.js";
import type { Logger } from "../logger.js";

/** A reserved root-level journal file; appended to by every mutation. */
const LOG_FILE = "_log.md";

export interface TreeNode {
  name: string;
  path: string; // vault-relative, POSIX separators
  type: "dir" | "file";
  children?: TreeNode[];
}

/**
 * Transaction handle handed to a mutation body. Every filesystem change goes through
 * these methods so the core can (a) enforce confinement, (b) track touched paths for the
 * commit, and (c) roll back on failure. There is no raw fs access inside a mutation.
 */
export interface Tx {
  /** Atomically write a file (extension-allowlisted, confined). */
  writeFile(rel: string, contents: string): void;
  /** Create a directory (and parents) inside the vault. */
  mkdir(rel: string): void;
  /** Move/rename a path within the vault (used by move/promote/soft_delete). */
  move(fromRel: string, toRel: string): void;
  /** Read a file during the transaction (e.g. append-to-home read-modify-write). */
  read(rel: string): string;
  exists(rel: string): boolean;
  /** Mark a path as touched without writing (e.g. a deletion staged elsewhere). */
  touch(rel: string): void;
  /**
   * Move a path into `.trash/<timestamp>/…` (the ONLY way .trash is ever written — callers
   * cannot target it directly, lesson H-1). Returns the trash-relative destination.
   */
  trash(rel: string): string;
}

export interface MutationSpec<T> {
  /** Short operation name for the journal, e.g. "create_note". */
  op: string;
  /** Git commit message. */
  message: string;
  /** Metadata-only journal note (no file bodies — lesson H-5). */
  journal?: Record<string, string | number | string[]>;
  body: (tx: Tx) => Promise<T>;
}

export class VaultCore {
  readonly paths: VaultPaths;
  private readonly gate: WriteGate;
  private readonly git: VaultGit;
  private readonly log: Logger;

  constructor(opts: {
    vaultRoot: string;
    git: GitIdentity;
    logger: Logger;
  }) {
    this.paths = new VaultPaths(opts.vaultRoot);
    this.gate = new WriteGate(opts.vaultRoot);
    this.git = new VaultGit(opts.vaultRoot, opts.git);
    this.log = opts.logger;
  }

  /** One-time startup: ensure the vault is a git repo. Perms/init happen once (L-1). */
  async init(): Promise<void> {
    await this.git.ensureRepo();
  }

  // ----------------------------- read side -----------------------------

  readTextFile(rel: string): string {
    const abs = this.paths.resolveExisting(rel);
    const st = statSync(abs);
    if (!st.isFile()) throw new CoreError("NOT_A_FILE", "not a file");
    return readFileSync(abs, "utf8");
  }

  statKind(rel: string): "file" | "dir" {
    const abs = this.paths.resolveExisting(rel);
    return statSync(abs).isDirectory() ? "dir" : "file";
  }

  pathExists(rel: string): boolean {
    try {
      this.paths.resolveExisting(rel);
      return true;
    } catch {
      return false;
    }
  }

  /** Build a tree listing, skipping reserved dirs and dotfiles by default. */
  listTree(opts?: { rel?: string; maxDepth?: number; includeFiles?: boolean }): TreeNode {
    const rel = opts?.rel ?? ".";
    const maxDepth = opts?.maxDepth ?? Infinity;
    const includeFiles = opts?.includeFiles ?? true;
    const rootAbs = this.paths.resolveDir(rel);

    const walk = (abs: string, depth: number): TreeNode => {
      const node: TreeNode = {
        name: path.basename(abs) || this.paths.toRel(abs) || ".",
        path: this.paths.toRel(abs) || ".",
        type: "dir",
        children: [],
      };
      if (depth >= maxDepth) return node;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return node;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith(".")) continue; // skip .git/.obsidian/.trash and temp files
        const childAbs = path.join(abs, e.name);
        if (e.isDirectory()) {
          node.children!.push(walk(childAbs, depth + 1));
        } else if (includeFiles && e.isFile()) {
          node.children!.push({
            name: e.name,
            path: this.paths.toRel(childAbs),
            type: "file",
          });
        }
      }
      return node;
    };

    return walk(rootAbs, 0);
  }

  /** Absolute path resolver for read-only consumers (e.g. search) — confined. */
  resolveForRead(rel: string): string {
    return this.paths.resolveExisting(rel);
  }

  get root(): string {
    return this.paths.root;
  }

  // ----------------------------- write side -----------------------------

  /**
   * Run a mutation atomically: acquire the vault lock, execute the body, append a
   * metadata-only journal line, then commit all touched paths. On any error, roll the
   * touched paths back to HEAD so the vault is never left half-written (techplan §4).
   */
  async mutate<T>(spec: MutationSpec<T>): Promise<T> {
    return this.gate.run(async () => {
      const touched = new Set<string>();
      const tx = this.makeTx(touched);
      try {
        const result = await spec.body(tx);
        this.appendJournal(spec.op, spec.journal, touched);
        const commitPaths = [...touched, LOG_FILE];
        const oid = await this.git.commit(spec.message, commitPaths);
        this.log.info("mutation", {
          op: spec.op,
          touchedCount: touched.size,
          commit: oid ? oid.slice(0, 10) : "none",
        });
        return result;
      } catch (err) {
        // Roll back the working tree for everything we touched.
        await this.git.checkoutHead([...touched]).catch(() => undefined);
        this.log.warn("mutation_failed", {
          op: spec.op,
          touchedCount: touched.size,
          reason: (err as Error).message,
        });
        throw err;
      }
    });
  }

  private makeTx(touched: Set<string>): Tx {
    const record = (abs: string) => touched.add(this.paths.toRel(abs));
    return {
      writeFile: (rel, contents) => {
        const abs = this.paths.resolveForWrite(rel);
        atomicWrite(abs, contents);
        record(abs);
      },
      mkdir: (rel) => {
        const abs = this.paths.resolveDir(rel);
        mkdirSync(abs, { recursive: true });
        record(abs);
      },
      move: (fromRel, toRel) => {
        const fromAbs = this.paths.resolveExisting(fromRel);
        // Destination may be a dir (resolveDir) or file (resolveForWrite) depending on
        // the source; choose by the source kind.
        const srcIsDir = statSync(fromAbs).isDirectory();
        const toAbs = srcIsDir ? this.paths.resolveDir(toRel) : this.paths.resolveForWrite(toRel);
        mkdirSync(path.dirname(toAbs), { recursive: true });
        renameSync(fromAbs, toAbs);
        record(fromAbs);
        record(toAbs);
      },
      read: (rel) => this.readTextFile(rel),
      exists: (rel) => this.pathExists(rel),
      touch: (rel) => touched.add(rel),
      trash: (rel) => {
        const fromAbs = this.paths.resolveExisting(rel);
        // Compute a .trash destination directly (bypassing the reserved-dir guard, which
        // exists to stop *callers* from writing there — this is the core's own path).
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const destRel = path.posix.join(".trash", stamp, this.paths.toRel(fromAbs));
        const destAbs = path.join(this.paths.root, destRel);
        mkdirSync(path.dirname(destAbs), { recursive: true });
        renameSync(fromAbs, destAbs);
        record(fromAbs);
        touched.add(destRel);
        return destRel;
      },
    };
  }

  private appendJournal(
    op: string,
    journal: Record<string, string | number | string[]> | undefined,
    touched: Set<string>,
  ): void {
    const logAbs = path.join(this.paths.root, LOG_FILE);
    const prior = existsSync(logAbs) ? readFileSync(logAbs, "utf8") : "# _log\n\nAppend-only operation journal. Metadata only — never note bodies.\n";
    const ts = new Date().toISOString();
    const targets = [...touched].filter((p) => p !== LOG_FILE);
    const meta = journal ? " " + JSON.stringify(journal) : "";
    const line = `- ${ts} · ${op} · ${targets.join(", ") || "(none)"}${meta}\n`;
    atomicWrite(logAbs, prior.endsWith("\n") ? prior + line : prior + "\n" + line);
    touched.add(LOG_FILE);
  }
}

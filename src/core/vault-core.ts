import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  renameSync,
  mkdirSync,
  rmSync,
  appendFileSync,
  truncateSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { VaultPaths, isWithin } from "./paths.js";
import { WriteGate } from "./lock.js";
import { VaultGit, type GitIdentity } from "./git.js";
import { atomicWrite } from "./atomic.js";
import { CoreError } from "./errors.js";
import type { Logger } from "../logger.js";

/** A reserved root-level journal file; appended to by every mutation. */
const LOG_FILE = "_log.md";
const LOG_HEADER = "# _log\n\nAppend-only operation journal. Metadata only — never note bodies.\n";
/** Cap journal target lists so a large folder move cannot bloat a journal line. */
const JOURNAL_MAX_TARGETS = 20;

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

/** One reversible step of a transaction; rollback replays these in LIFO order. */
type UndoStep = () => void;

/** All regular files under a directory (absolute paths), including dotfiles. */
function walkFilesAbs(absDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(absDir);
  return out;
}

export class VaultCore {
  readonly paths: VaultPaths;
  private readonly gate: WriteGate;
  private readonly git: VaultGit;
  private readonly log: Logger;
  /** Invoked after every successful mutation (e.g. graph cache invalidation). */
  private mutationListener: (() => void) | null = null;

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

  /** Register the single post-mutation hook. A throwing listener never fails the mutation. */
  onMutation(listener: () => void): void {
    this.mutationListener = listener;
  }

  // ----------------------------- read side -----------------------------

  readTextFile(rel: string): string {
    const abs = this.paths.resolveExisting(rel);
    const st = statSync(abs);
    if (!st.isFile()) throw new CoreError("NOT_A_FILE", "not a file");
    return readFileSync(abs, "utf8");
  }

  /** Read a binary file (e.g. a PDF in _attachments/) with a hard size cap. */
  readBinaryFile(rel: string, maxBytes: number): Buffer {
    const abs = this.paths.resolveExisting(rel);
    const st = statSync(abs);
    if (!st.isFile()) throw new CoreError("NOT_A_FILE", "not a file");
    if (st.size > maxBytes) {
      throw new CoreError("INVALID_NAME", `file is too large (${st.size} bytes; cap is ${maxBytes})`);
    }
    return readFileSync(abs);
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
   * metadata-only journal line, then commit all touched paths. On any error, replay the
   * transaction's undo log (LIFO) so the vault is never left half-written (techplan §4).
   * The undo log — not `git checkout` — is the rollback mechanism: it restores files that
   * never existed in HEAD (new creations, files a human added but no mutation committed yet)
   * and reverses moves by renaming back, so no content can be lost on rollback.
   */
  async mutate<T>(spec: MutationSpec<T>): Promise<T> {
    return this.gate.run(async () => {
      const touched = new Set<string>();
      const undo: UndoStep[] = [];
      const tx = this.makeTx(touched, undo);
      try {
        const result = await spec.body(tx);
        this.appendJournal(spec.op, spec.journal, touched, undo);
        const commitPaths = [...touched];
        const oid = await this.git.commit(spec.message, commitPaths);
        this.log.info("mutation", {
          op: spec.op,
          touchedCount: touched.size,
          commit: oid ? oid.slice(0, 10) : "none",
        });
        try {
          this.mutationListener?.();
        } catch (err) {
          this.log.warn("mutation_listener_failed", { op: spec.op, reason: (err as Error).message });
        }
        return result;
      } catch (err) {
        this.rollback(undo, spec.op);
        this.log.warn("mutation_failed", {
          op: spec.op,
          touchedCount: touched.size,
          reason: (err as Error).message,
        });
        throw err;
      }
    });
  }

  /** Replay undo steps newest-first; a failing step is logged but does not stop the rest. */
  private rollback(undo: UndoStep[], op: string): void {
    for (let i = undo.length - 1; i >= 0; i--) {
      try {
        undo[i]!();
      } catch (err) {
        this.log.warn("rollback_step_failed", { op, step: i, reason: (err as Error).message });
      }
    }
  }

  private makeTx(touched: Set<string>, undo: UndoStep[]): Tx {
    const record = (abs: string) => touched.add(this.paths.toRel(abs));

    // git tracks files, not directories: when a directory moves, stage each contained
    // file's old and new path so deletions actually land in the commit (a directory
    // path handed to git.add/git.remove is silently useless — the v0.1 folder-move bug).
    const recordMovedFiles = (fromAbs: string, toAbs: string, srcIsDir: boolean) => {
      if (!srcIsDir) {
        record(fromAbs);
        record(toAbs);
        return;
      }
      // Called BEFORE the rename: walk the source while it still exists.
      for (const f of walkFilesAbs(fromAbs)) {
        record(f);
        record(path.join(toAbs, path.relative(fromAbs, f)));
      }
    };

    return {
      writeFile: (rel, contents) => {
        const abs = this.paths.resolveForWrite(rel);
        const prior = existsSync(abs) ? readFileSync(abs, "utf8") : null;
        atomicWrite(abs, contents);
        undo.push(() => {
          if (prior === null) rmSync(abs, { force: true });
          else atomicWrite(abs, prior);
        });
        record(abs);
      },
      mkdir: (rel) => {
        const abs = this.paths.resolveDir(rel);
        if (existsSync(abs)) return;
        // Undo must remove exactly what this call creates: the topmost ancestor that
        // does not exist yet (mkdirSync recursive creates the whole chain).
        let top = abs;
        for (let parent = path.dirname(top); !existsSync(parent) && isWithin(this.paths.root, parent); parent = path.dirname(top)) {
          top = parent;
        }
        mkdirSync(abs, { recursive: true });
        undo.push(() => rmSync(top, { recursive: true, force: true }));
      },
      move: (fromRel, toRel) => {
        const fromAbs = this.paths.resolveExisting(fromRel);
        // Destination may be a dir (resolveDir) or file (resolveForWrite) depending on
        // the source; choose by the source kind.
        const srcIsDir = statSync(fromAbs).isDirectory();
        const toAbs = srcIsDir ? this.paths.resolveDir(toRel) : this.paths.resolveForWrite(toRel);
        // Refuse to clobber an existing destination — except a pure case-rename, where a
        // case-insensitive filesystem reports the source itself as "existing".
        const caseRenameOnly = fromAbs.toLowerCase() === toAbs.toLowerCase();
        if (existsSync(toAbs) && !caseRenameOnly) {
          throw new CoreError("ALREADY_EXISTS", "destination already exists; refusing to overwrite");
        }
        recordMovedFiles(fromAbs, toAbs, srcIsDir);
        mkdirSync(path.dirname(toAbs), { recursive: true });
        renameSync(fromAbs, toAbs);
        undo.push(() => {
          mkdirSync(path.dirname(fromAbs), { recursive: true });
          renameSync(toAbs, fromAbs);
        });
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
        const srcIsDir = statSync(fromAbs).isDirectory();
        recordMovedFiles(fromAbs, destAbs, srcIsDir);
        mkdirSync(path.dirname(destAbs), { recursive: true });
        renameSync(fromAbs, destAbs);
        undo.push(() => {
          mkdirSync(path.dirname(fromAbs), { recursive: true });
          renameSync(destAbs, fromAbs);
        });
        return destRel;
      },
    };
  }

  /**
   * Append one metadata line to the journal. True O(1) append (the file is never read or
   * rewritten whole — it grows for the life of the vault), with an undo step that truncates
   * back to the prior size so a failed commit does not leave a phantom journal entry.
   */
  private appendJournal(
    op: string,
    journal: Record<string, string | number | string[]> | undefined,
    touched: Set<string>,
    undo: UndoStep[],
  ): void {
    const logAbs = path.join(this.paths.root, LOG_FILE);
    const existed = existsSync(logAbs);
    const priorSize = existed ? statSync(logAbs).size : 0;

    // A human-edited journal may lack a trailing newline; check the last byte only.
    let needsNewline = false;
    if (existed && priorSize > 0) {
      const fd = openSync(logAbs, "r");
      try {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, priorSize - 1);
        needsNewline = last[0] !== 0x0a;
      } finally {
        closeSync(fd);
      }
    }

    const ts = new Date().toISOString();
    const targets = [...touched].filter((p) => p !== LOG_FILE);
    const shown = targets.length > JOURNAL_MAX_TARGETS
      ? [...targets.slice(0, JOURNAL_MAX_TARGETS), `…+${targets.length - JOURNAL_MAX_TARGETS} more`]
      : targets;
    const meta = journal ? " " + JSON.stringify(journal) : "";
    const line = `- ${ts} · ${op} · ${shown.join(", ") || "(none)"}${meta}\n`;

    const chunk = (existed ? (needsNewline ? "\n" : "") : LOG_HEADER) + line;
    appendFileSync(logAbs, chunk, "utf8");
    undo.push(() => {
      if (existed) truncateSync(logAbs, priorSize);
      else rmSync(logAbs, { force: true });
    });
    touched.add(LOG_FILE);
  }
}

import lockfile from "proper-lockfile";
import path from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { CoreError } from "./errors.js";

/**
 * Two-layer concurrency control:
 *
 *  1. In-process serialization: all mutations run through a single promise chain, so the
 *     server never races against itself even under concurrent requests.
 *  2. Cross-process advisory lock (proper-lockfile) on a sentinel file, with stale reaping
 *     (~60s) so a crashed holder cannot wedge the vault. This guards MCP ↔ bot ↔ Obsidian.
 *
 * The lock is intentionally coarse (one vault-wide lock). For a single-user second brain
 * this is simpler and safe; throughput is not a concern. The human-edits-same-file case is
 * a documented best-effort limitation, mitigated by atomic writes — not fully prevented.
 */

const LOCK_STALE_MS = 60_000;
const LOCK_RETRIES = { retries: 10, factor: 1.6, minTimeout: 50, maxTimeout: 1000 };

export class WriteGate {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;

  constructor(private readonly vaultRoot: string) {
    // proper-lockfile locks an existing path by creating <target>.lock alongside it.
    // We use a dedicated dotfile sentinel: it's skipped by the tree walk and gitignored.
    // Crucially we do NOT touch .git here — pre-creating it would make git.init() skip
    // initialization and leave HEAD unwritten.
    this.lockTarget = path.join(vaultRoot, ".vault-lock");
    if (!existsSync(this.lockTarget)) {
      writeFileSync(this.lockTarget, "vault-mcp advisory lock sentinel\n", { encoding: "utf8" });
    }
  }

  /**
   * Run `fn` with both the in-process serialization and the cross-process advisory lock
   * held. Returns the function's result. Lock acquisition failure surfaces as LOCK_TIMEOUT.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      let release: (() => Promise<void>) | null = null;
      try {
        release = await lockfile.lock(this.lockTarget, {
          stale: LOCK_STALE_MS,
          retries: LOCK_RETRIES,
          realpath: false,
        });
      } catch (err) {
        throw new CoreError("LOCK_TIMEOUT", `could not acquire vault lock: ${(err as Error).message}`);
      }
      try {
        return await fn();
      } finally {
        if (release) {
          await release().catch(() => {
            /* release failure is non-fatal; stale reaping will recover */
          });
        }
      }
    });
    // Keep the chain alive even if this op rejects, so one failure doesn't poison the queue.
    this.chain = next.catch(() => undefined);
    return next;
  }
}

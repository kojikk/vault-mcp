import git from "isomorphic-git";
import fs from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Local-only git via isomorphic-git (pure JS — no `git` binary, no child process, no
 * network). This deliberately removes an entire RCE/arg-injection surface (lessons
 * C-5/L-3/M-6): there is no command line to inject into. There is also no `push`/`fetch`
 * anywhere in the codebase, reinforcing the no-egress leg of the triad.
 */

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export class VaultGit {
  constructor(
    private readonly dir: string,
    private readonly author: GitIdentity,
  ) {}

  /** Initialize a repo and a .gitignore if the vault is not yet versioned. */
  async ensureRepo(): Promise<void> {
    if (!existsSync(path.join(this.dir, ".git"))) {
      await git.init({ fs, dir: this.dir, defaultBranch: "main" });
    }
    const ignore = path.join(this.dir, ".gitignore");
    if (!existsSync(ignore)) {
      fs.writeFileSync(ignore, [".obsidian/", ".tmp-*", ".vault-lock", ".vault-lock.lock", ""].join("\n"), "utf8");
    }
  }

  /**
   * Stage the given vault-relative paths (or all changes) and create a commit.
   * Returns the commit oid, or null if there was nothing to commit.
   */
  async commit(message: string, relPaths?: string[]): Promise<string | null> {
    if (relPaths && relPaths.length > 0) {
      for (const rel of relPaths) {
        const abs = path.join(this.dir, rel);
        if (existsSync(abs)) {
          await git.add({ fs, dir: this.dir, filepath: rel });
        } else {
          // Path was removed (e.g. moved/trashed) — stage the deletion.
          await git.remove({ fs, dir: this.dir, filepath: rel }).catch(() => undefined);
        }
      }
    } else {
      await this.stageAll();
    }

    const status = await this.hasStagedChanges();
    if (!status) return null;

    return git.commit({
      fs,
      dir: this.dir,
      message,
      author: { name: this.author.name, email: this.author.email },
    });
  }

  private async stageAll(): Promise<void> {
    const matrix = await git.statusMatrix({ fs, dir: this.dir });
    for (const [filepath, head, workdir] of matrix) {
      if (workdir === 0 && head === 1) {
        await git.remove({ fs, dir: this.dir, filepath }).catch(() => undefined);
      } else {
        await git.add({ fs, dir: this.dir, filepath }).catch(() => undefined);
      }
    }
  }

  private async hasStagedChanges(): Promise<boolean> {
    const matrix = await git.statusMatrix({ fs, dir: this.dir });
    // [filepath, HEAD, WORKDIR, STAGE]; staged change when STAGE !== HEAD.
    return matrix.some(([, head, , stage]) => stage !== head);
  }

  /** Revert the working tree of the given paths to HEAD (transaction rollback helper). */
  async checkoutHead(relPaths: string[]): Promise<void> {
    await git.checkout({
      fs,
      dir: this.dir,
      force: true,
      filepaths: relPaths,
    }).catch(() => undefined);
  }
}

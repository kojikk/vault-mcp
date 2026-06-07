import { execFile } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import type { VaultPaths } from "./paths.js";

/**
 * Content/tag search via ripgrep.
 *
 * This is the ONLY child process the MCP ever spawns (per the §9 decision). It is invoked
 * with execFile and a fixed ARGUMENT ARRAY — never a shell string — so there is no command
 * or argument injection surface (lessons C-5/L-3/M-6):
 *   - the user pattern is bound with `-e <pattern>`, so a leading '-' can't become a flag;
 *   - search is rooted at VAULT_ROOT and reserved dirs are globbed out;
 *   - output is parsed from `--json`, not scraped from a shell.
 */

export interface SearchHit {
  /** Vault-relative path (POSIX separators). */
  path: string;
  line: number;
  /** Trimmed matching line; truncated to keep results small. */
  preview: string;
}

export type SearchKind = "content" | "tag";

const MAX_PREVIEW = 200;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function search(
  paths: VaultPaths,
  opts: { query: string; kind?: SearchKind; limit?: number },
): Promise<SearchHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const kind = opts.kind ?? "content";

  // Build the pattern. `tag` searches for an Obsidian #tag token.
  let pattern: string;
  let fixedStrings = false;
  if (kind === "tag") {
    const tag = opts.query.replace(/^#/, "");
    pattern = `(^|\\s)#${escapeRegex(tag)}\\b`;
  } else {
    pattern = opts.query;
    fixedStrings = true;
  }

  const args = [
    "--json",
    "--ignore-case",
    "--max-count",
    "50",
    "-g",
    "!.git",
    "-g",
    "!.obsidian",
    "-g",
    "!.trash",
    "-g",
    "!.tmp-*",
  ];
  if (fixedStrings) args.push("--fixed-strings");
  args.push("-e", pattern, "--", paths.root);

  return new Promise<SearchHit[]>((resolve, reject) => {
    execFile(
      rgPath,
      args,
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 15_000 },
      (err, stdout) => {
        // ripgrep exits 1 when there are no matches — that's success with empty results.
        if (err && (err as NodeJS.ErrnoException & { code?: number }).code === 1 && !stdout) {
          resolve([]);
          return;
        }
        if (err && !stdout) {
          reject(err);
          return;
        }
        const hits: SearchHit[] = [];
        for (const raw of stdout.split("\n")) {
          if (!raw.trim()) continue;
          if (hits.length >= limit) break;
          let evt: unknown;
          try {
            evt = JSON.parse(raw);
          } catch {
            continue;
          }
          const e = evt as {
            type?: string;
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
          };
          if (e.type !== "match" || !e.data?.path?.text) continue;
          const absPath = e.data.path.text;
          const rel = paths.toRel(absPath);
          // Defense in depth: drop anything that somehow isn't under the vault.
          if (rel.startsWith("..")) continue;
          const lineText = (e.data.lines?.text ?? "").replace(/\r?\n$/, "").trim();
          hits.push({
            path: rel,
            line: e.data.line_number ?? 0,
            preview: lineText.length > MAX_PREVIEW ? lineText.slice(0, MAX_PREVIEW) + "…" : lineText,
          });
        }
        resolve(hits);
      },
    );
  });
}

import { readFileSync } from "node:fs";
import path from "node:path";
import type { VaultCore, TreeNode } from "./vault-core.js";

/**
 * Backlink repair for moves/renames (invariant: no broken links after an operation).
 *
 * Obsidian links come in two shapes we repair:
 *   - wikilinks: [[target]], [[target|alias]], [[target#heading]], where `target` is either
 *     a note basename (no extension) or a vault-relative path (no extension).
 *   - markdown links: [text](path.md) with a vault-relative path.
 *
 * We compute edits over every .md file EXCEPT the ones being moved, so the plan is identical
 * whether evaluated before (dry-run) or after (apply) the physical move — the planner never
 * depends on the moved file's new location.
 */

export interface Rename {
  fromRel: string; // .md file, vault-relative (POSIX)
  toRel: string;
}

export interface BacklinkEdit {
  file: string; // vault-relative
  newContent: string;
  replacements: number;
}

function noExt(rel: string): string {
  return rel.replace(/\.md$/i, "");
}

function collectMarkdownFiles(core: VaultCore): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.type === "file") {
      if (n.path.toLowerCase().endsWith(".md")) out.push(n.path);
    } else if (n.children) {
      for (const c of n.children) walk(c);
    }
  };
  walk(core.listTree({ rel: ".", includeFiles: true }));
  return out;
}

function applyRenamesToContent(content: string, renames: Rename[]): { text: string; count: number } {
  let count = 0;
  let text = content;

  for (const r of renames) {
    const fromBase = path.posix.basename(noExt(r.fromRel));
    const toBase = path.posix.basename(noExt(r.toRel));
    const fromPath = noExt(r.fromRel);
    const toPath = noExt(r.toRel);

    // Wikilinks: capture target, optional #heading, optional |alias.
    text = text.replace(/\[\[([^\]|#]+)(#[^\]|]+)?(\|[^\]]+)?\]\]/g, (m, target: string, heading = "", alias = "") => {
      const t = target.trim();
      let replaced: string | null = null;
      if (t === fromPath) replaced = toPath;
      else if (t === fromBase) replaced = toBase;
      if (replaced === null) return m;
      count++;
      return `[[${replaced}${heading}${alias}]]`;
    });

    // Markdown links to the path (with or without extension).
    text = text.replace(/\]\(([^)]+)\)/g, (m, link: string) => {
      const raw = link.trim();
      const rawNoExt = noExt(raw);
      if (raw === r.fromRel || rawNoExt === fromPath) {
        count++;
        const keepsExt = /\.md$/i.test(raw);
        return `](${keepsExt ? r.toRel : toPath})`;
      }
      return m;
    });
  }

  return { text, count };
}

/**
 * Compute backlink edits for a set of renames. `excludeRels` (the files being moved) are not
 * scanned, keeping dry-run and apply identical.
 */
export function planBacklinkFixes(core: VaultCore, renames: Rename[], excludeRels: Set<string>): BacklinkEdit[] {
  const edits: BacklinkEdit[] = [];
  for (const file of collectMarkdownFiles(core)) {
    if (excludeRels.has(file)) continue;
    let content: string;
    try {
      content = readFileSync(path.join(core.root, file), "utf8");
    } catch {
      continue;
    }
    const { text, count } = applyRenamesToContent(content, renames);
    if (count > 0 && text !== content) {
      edits.push({ file, newContent: text, replacements: count });
    }
  }
  return edits;
}

/** Count inbound links to a target (used to warn before soft_delete). */
export function countInboundLinks(core: VaultCore, targetRel: string): number {
  const fromBase = path.posix.basename(noExt(targetRel));
  const fromPath = noExt(targetRel);
  let count = 0;
  for (const file of collectMarkdownFiles(core)) {
    if (file === targetRel) continue;
    let content: string;
    try {
      content = readFileSync(path.join(core.root, file), "utf8");
    } catch {
      continue;
    }
    const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const t = (m[1] ?? "").trim();
      if (t === fromBase || t === fromPath) count++;
    }
  }
  return count;
}

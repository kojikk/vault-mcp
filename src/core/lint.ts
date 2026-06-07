import { readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { VaultCore, TreeNode } from "./vault-core.js";

/**
 * Vault health audit (agent.md §13). Read-only: it never mutates, it just reports. The brain
 * decides what to fix. Heuristics are intentionally conservative — false positives are noise,
 * not damage. Checks:
 *   1. orphans          — note/entity pages with no inbound links
 *   2. brokenLinks      — [[wikilinks]]/embeds whose target file does not exist
 *   3. staleEntities    — type:entity pages whose `updated` is older than ~3 months (or missing)
 *   4. unlinkedRaw      — files in _raw/ not referenced from outside _raw/ (ingest not done)
 *   5. openContradictions — rows in _contradictions.md still marked `open`
 */

const STALE_DAYS = 90;
const ROOT_SERVICE = new Set(["_index.md", "_hot.md", "_log.md", "_contradictions.md"]);
const STRUCTURAL_BASENAMES = new Set(["_home.md", "_memory.md"]);
const SKIP_ZONES = ["_system", "_templates", "_raw", "_attachments"];

export interface LintReport {
  orphans: string[];
  brokenLinks: { file: string; target: string }[];
  staleEntities: { file: string; updated: string; ageDays: number }[];
  unlinkedRaw: string[];
  openContradictions: number;
}

function isUnder(rel: string, dir: string): boolean {
  return rel === dir || rel.startsWith(dir + "/");
}

function allFiles(core: VaultCore): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.type === "file") out.push(n.path);
    else if (n.children) for (const c of n.children) walk(c);
  };
  walk(core.listTree({ rel: ".", includeFiles: true }));
  return out;
}

const noExt = (rel: string): string => rel.replace(/\.md$/i, "");

/** All [[wikilink]] / ![[embed]] targets in a body (heading/alias stripped). */
function extractTargets(content: string): string[] {
  const re = /!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  const targets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const t = (m[1] ?? "").trim();
    if (t) targets.push(t);
  }
  return targets;
}

export function runLint(core: VaultCore): LintReport {
  const files = allFiles(core);
  const mdFiles = files.filter((f) => f.toLowerCase().endsWith(".md"));

  // Resolution sets for broken-link detection (a link resolves by path or basename,
  // with or without the .md extension).
  const pathsWithExt = new Set<string>();
  const basenamesWithExt = new Set<string>();
  const pathsNoExt = new Set<string>();
  const basenamesNoExt = new Set<string>();
  for (const f of files) {
    pathsWithExt.add(f);
    basenamesWithExt.add(path.posix.basename(f));
    if (f.toLowerCase().endsWith(".md")) {
      const ne = noExt(f);
      pathsNoExt.add(ne);
      basenamesNoExt.add(path.posix.basename(ne));
    }
  }
  const resolves = (t: string): boolean => {
    if (pathsWithExt.has(t) || pathsNoExt.has(t)) return true;
    const b = path.posix.basename(t);
    return basenamesWithExt.has(b) || basenamesNoExt.has(b);
  };

  // Read every markdown body once.
  const contents = new Map<string, string>();
  for (const f of mdFiles) {
    try {
      contents.set(f, readFileSync(path.join(core.root, f), "utf8"));
    } catch {
      /* unreadable file — skip */
    }
  }

  // Single pass over links: collect broken links and a "what is referenced" set,
  // split by whether the linking file lives in _raw/ (for unlinkedRaw).
  const brokenLinks: { file: string; target: string }[] = [];
  const referenced = new Set<string>();
  const referencedFromKnowledge = new Set<string>();
  for (const [file, content] of contents) {
    const fromRaw = isUnder(file, "_raw");
    for (const target of extractTargets(content)) {
      if (!resolves(target)) {
        brokenLinks.push({ file, target });
        continue;
      }
      const b = path.posix.basename(target);
      referenced.add(target);
      referenced.add(b);
      if (!fromRaw) {
        referencedFromKnowledge.add(target);
        referencedFromKnowledge.add(b);
      }
    }
  }
  const isReferenced = (f: string, set: Set<string>): boolean =>
    set.has(f) || set.has(noExt(f)) || set.has(path.posix.basename(f)) || set.has(path.posix.basename(noExt(f)));

  // Orphans + stale entities.
  const orphans: string[] = [];
  const staleEntities: { file: string; updated: string; ageDays: number }[] = [];
  const now = Date.now();
  for (const f of mdFiles) {
    const base = path.posix.basename(f);
    const inSkipZone = SKIP_ZONES.some((z) => isUnder(f, z));
    const isService = ROOT_SERVICE.has(f) || STRUCTURAL_BASENAMES.has(base);

    if (!inSkipZone && !isService && !isReferenced(f, referenced)) {
      orphans.push(f);
    }

    // Stale entity check (entity pages may live anywhere, but never in raw/attachments).
    if (!isUnder(f, "_raw") && !isUnder(f, "_attachments")) {
      const body = contents.get(f);
      if (body) {
        let data: Record<string, unknown> = {};
        try {
          data = matter(body).data as Record<string, unknown>;
        } catch {
          data = {};
        }
        if (data.type === "entity") {
          const raw = data.updated;
          const ts = raw ? Date.parse(String(raw)) : NaN;
          if (Number.isNaN(ts)) {
            staleEntities.push({ file: f, updated: raw ? String(raw) : "(missing)", ageDays: -1 });
          } else {
            const ageDays = Math.floor((now - ts) / 86_400_000);
            if (ageDays > STALE_DAYS) staleEntities.push({ file: f, updated: String(raw), ageDays });
          }
        }
      }
    }
  }

  // Unlinked raw sources (real files under _raw/, not the .gitkeep placeholders).
  const unlinkedRaw = files
    .filter((f) => isUnder(f, "_raw") && !path.posix.basename(f).startsWith("."))
    .filter((f) => !isReferenced(f, referencedFromKnowledge));

  // Open contradictions: count table rows whose status cell is "open".
  let openContradictions = 0;
  if (contents.has("_contradictions.md") || core.pathExists("_contradictions.md")) {
    let body = contents.get("_contradictions.md");
    if (body === undefined) {
      try {
        body = readFileSync(path.join(core.root, "_contradictions.md"), "utf8");
      } catch {
        body = "";
      }
    }
    for (const line of body.split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      const cells = line.split("|").map((c) => c.trim());
      // Drop the leading/trailing empties from the surrounding pipes.
      const inner = cells.slice(1, -1);
      if (inner.length < 7) continue;
      const status = (inner[inner.length - 1] ?? "").toLowerCase();
      if (status === "open") openContradictions++;
    }
  }

  return { orphans, brokenLinks, staleEntities, unlinkedRaw, openContradictions };
}

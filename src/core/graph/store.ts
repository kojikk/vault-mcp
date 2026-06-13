import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { VaultCore } from "../vault-core.js";
import { CoreError } from "../errors.js";
import type { CodeKind, Confidence } from "./types.js";

/**
 * Semantic edge store — the persisted half of the graph.
 *
 * Format: _system/graph-edges.md, a markdown container whose payload lines are JSONL
 * (one edge object per line, lines starting with '{'). Using .md keeps the file inside
 * the existing write allowlist and security envelope — no new extensions, no new write
 * surface. Append-only by convention: a wrong edge is retracted by appending the same
 * src/tgt with relation "retracted", never by rewriting history (mirrors _raw/).
 */

export const EDGES_FILE = "_system/graph-edges.md";
export const RETRACTED = "retracted";

const EDGES_HEADER =
  "# graph-edges\n\n" +
  "Append-only semantic edge store (written by `graph_upsert`, read by the graph layer and lint).\n" +
  "One JSON object per line below. Do not edit lines by hand; retract a wrong edge by\n" +
  `appending the same src/tgt with relation "${RETRACTED}".\n\n`;

export const SemanticEdgeSchema = z.object({
  src: z.string().min(1).max(300),
  tgt: z.string().min(1).max(300),
  relation: z.string().min(1).max(120),
  confidence: z.enum(["extracted", "inferred", "ambiguous"]).default("extracted"),
  source_note: z.string().max(300).optional(),
  created: z.string().max(40).optional(),
});

export type SemanticEdge = z.infer<typeof SemanticEdgeSchema>;

/** Cap the store so unbounded appends cannot bloat the vault (≈ tens of thousands of edges). */
const MAX_EDGES_BYTES = 8 * 1024 * 1024;

export interface SemanticLoad {
  edges: SemanticEdge[];
  /** Lines that failed JSON/schema validation — counted, never fatal (content is data). */
  skipped: number;
}

export function loadSemantic(vaultRoot: string): SemanticLoad {
  const abs = path.join(vaultRoot, EDGES_FILE);
  if (!existsSync(abs)) return { edges: [], skipped: 0 };
  let body: string;
  try {
    body = readFileSync(abs, "utf8");
  } catch {
    return { edges: [], skipped: 0 };
  }
  const edges: SemanticEdge[] = [];
  let skipped = 0;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const parsed = SemanticEdgeSchema.safeParse(JSON.parse(t));
      if (parsed.success) edges.push(parsed.data);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { edges, skipped };
}

/**
 * Append validated edges through the normal mutation pipeline (atomic, locked,
 * journaled, committed). Callers pass already-schema-checked edges; this re-serializes
 * them (never raw caller text), so a payload cannot break the line format.
 */
export async function appendSemantic(core: VaultCore, edges: SemanticEdge[]): Promise<string> {
  const lines = edges.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await core.mutate({
    op: "graph_upsert",
    message: `graph_upsert: ${edges.length} edge(s)`,
    journal: { count: edges.length },
    body: async (tx) => {
      const prior = tx.exists(EDGES_FILE) ? tx.read(EDGES_FILE) : EDGES_HEADER;
      if (prior.length + lines.length > MAX_EDGES_BYTES) {
        throw new CoreError("INVALID_NAME", "graph edge store exceeds its size cap; compact it before appending");
      }
      const base = prior.endsWith("\n") ? prior : prior + "\n";
      tx.writeFile(EDGES_FILE, base + lines);
    },
  });
  return `appended ${edges.length} semantic edge(s) to ${EDGES_FILE}`;
}

/* ------------------------------------------------------------------------- *
 * Code namespaces (GRAPH-PLAN-CODE.md)
 *
 * A code namespace is a SNAPSHOT of one project's code graph, produced outside the server
 * (graphify / codegraph-sync on the host) and dropped at _system/graph/code/<project>.jsonl.
 * The server only ever READS these files — it never writes them, so the write allowlist is
 * untouched and the "no new write surface" invariant holds. The file is a whole-file
 * snapshot (replaced on every rescan), not an append journal like the semantic store, so
 * there is no retraction model: a stale graph is fixed by re-running the sync.
 * ------------------------------------------------------------------------- */

export const CODE_DIR = "_system/graph/code";
/** Project names are part of a filesystem path; keep them to a strict, traversal-proof set. */
const PROJECT_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Per-namespace size cap (snapshots are machine-generated; guard against a runaway file). */
const MAX_CODE_BYTES = 16 * 1024 * 1024;

export function isValidProject(project: string): boolean {
  return PROJECT_RE.test(project);
}

/** Vault-relative path for a project's code-namespace snapshot. */
export function codeNsRel(project: string): string {
  if (!isValidProject(project)) throw new CoreError("INVALID_NAME", `invalid code project name: ${project}`);
  return `${CODE_DIR}/${project}.jsonl`;
}

const CodeMetaSchema = z.object({
  t: z.literal("meta"),
  project: z.string().min(1).max(80),
  repo: z.string().max(300).optional(),
  commit: z.string().max(80).optional(),
  scanned: z.string().max(40).optional(),
  generator: z.string().max(120).optional(),
});

const CodeNodeSchema = z.object({
  t: z.literal("node"),
  id: z.string().min(1).max(400),
  kind: z.enum(["module", "class", "function", "method", "note"]),
  file: z.string().max(400).optional(),
  line: z.number().int().nonnegative().max(10_000_000).optional(),
  sig: z.string().max(400).optional(),
});

const CodeEdgeSchema = z.object({
  t: z.literal("edge"),
  src: z.string().min(1).max(400),
  tgt: z.string().min(1).max(400),
  rel: z.string().min(1).max(60),
  conf: z.enum(["extracted", "inferred", "ambiguous"]).default("extracted"),
});

export interface CodeNodeRow {
  id: string;
  kind: CodeKind;
  file?: string;
  line?: number;
  sig?: string;
}
export interface CodeEdgeRow {
  src: string;
  tgt: string;
  rel: string;
  conf: Confidence;
}
export interface CodeNamespaceMeta {
  project: string;
  repo?: string;
  commit?: string;
  scanned?: string;
  generator?: string;
  nodes: number;
  edges: number;
  /** Lines that failed JSON/schema validation — counted, never fatal. */
  skipped: number;
  /** File mtime in ms — drives the index's "reload when the sync overwrote it" check. */
  mtimeMs: number;
}
export interface CodeNamespaceLoad extends CodeNamespaceMeta {
  nodeRows: CodeNodeRow[];
  edgeRows: CodeEdgeRow[];
}

/** Parse one namespace .jsonl into rows + meta. Malformed lines are skipped, never fatal. */
export function loadCodeNamespace(vaultRoot: string, project: string): CodeNamespaceLoad | null {
  const rel = codeNsRel(project);
  const abs = path.join(vaultRoot, rel);
  if (!existsSync(abs)) return null;
  let mtimeMs = 0;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    if (st.size > MAX_CODE_BYTES) {
      throw new CoreError("INVALID_NAME", `code namespace ${project} exceeds its size cap`);
    }
    mtimeMs = st.mtimeMs;
  } catch (err) {
    if (err instanceof CoreError) throw err;
    return null;
  }
  let body: string;
  try {
    body = readFileSync(abs, "utf8");
  } catch {
    return null;
  }

  const base: CodeNamespaceMeta = { project, nodes: 0, edges: 0, skipped: 0, mtimeMs };
  const nodeRows: CodeNodeRow[] = [];
  const edgeRows: CodeEdgeRow[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      base.skipped++;
      continue;
    }
    const tag = (obj as { t?: unknown }).t;
    if (tag === "meta") {
      const m = CodeMetaSchema.safeParse(obj);
      if (m.success) {
        base.repo = m.data.repo;
        base.commit = m.data.commit;
        base.scanned = m.data.scanned;
        base.generator = m.data.generator;
      } else base.skipped++;
    } else if (tag === "node") {
      const n = CodeNodeSchema.safeParse(obj);
      if (n.success) nodeRows.push({ id: n.data.id, kind: n.data.kind, file: n.data.file, line: n.data.line, sig: n.data.sig });
      else base.skipped++;
    } else if (tag === "edge") {
      const e = CodeEdgeSchema.safeParse(obj);
      if (e.success) edgeRows.push({ src: e.data.src, tgt: e.data.tgt, rel: e.data.rel, conf: e.data.conf });
      else base.skipped++;
    } else {
      base.skipped++;
    }
  }
  base.nodes = nodeRows.length;
  base.edges = edgeRows.length;
  return { ...base, nodeRows, edgeRows };
}

/** Light scan of the code-namespace directory: per-project counts + freshness, no graph build. */
export function listCodeNamespaces(vaultRoot: string): CodeNamespaceMeta[] {
  const dirAbs = path.join(vaultRoot, CODE_DIR);
  if (!existsSync(dirAbs)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return [];
  }
  const out: CodeNamespaceMeta[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const project = name.slice(0, -".jsonl".length);
    if (!isValidProject(project)) continue;
    try {
      const load = loadCodeNamespace(vaultRoot, project);
      if (load) {
        const { nodeRows: _n, edgeRows: _e, ...meta } = load;
        out.push(meta);
      }
    } catch {
      // a single broken/oversized namespace must not break the listing
    }
  }
  return out.sort((a, b) => a.project.localeCompare(b.project));
}

/**
 * Graph layer — shared types.
 *
 * Two-layer model (GRAPH-PLAN.md §1):
 *  - "derived"  — deterministically rebuilt from the vault's own files (wikilinks, embeds,
 *    tags, frontmatter). Never stored, can never drift from the notes.
 *  - "semantic" — typed edges the brain records during ingest (graph_upsert), persisted
 *    append-only in _system/graph-edges.md and validated by lint.
 *
 * Node identity:
 *  - note    → vault-relative .md path (e.g. "Знания/AI/RAG.md")
 *  - org     → folder path of a node that has _home.md/_memory.md (its service files'
 *              links are attributed to the folder, matching the vault's mental model)
 *  - tag     → "tag:<name>"
 *  - concept → "concept:<normalized label>" — a semantic-edge endpoint that resolves to
 *              no page yet; lint surfaces these as entity-page candidates.
 *
 * Code namespaces (GRAPH-PLAN-CODE.md) live in their OWN assembled graphs, never mixed
 * into the knowledge graph above. Two extra kinds carry them:
 *  - code     → a symbol inside a code namespace (module/class/function/method/note),
 *               id "<file>#<symbol>" or "<file>" for a module. Only ever appears in a
 *               graph built from _system/graph/code/<project>.jsonl.
 *  - codelink → a KB-side stub pointing INTO a code namespace, id "code:<project>/<id>".
 *               It is the far end of a bridge edge the brain records with graph_upsert;
 *               it is never expanded in KB results (there is nothing behind it in the KB
 *               graph) — graph_query only annotates it with the namespace's freshness.
 */

export type NodeKind = "note" | "org" | "tag" | "concept" | "code" | "codelink";
/** Symbol classes inside a code namespace (mirrors graphify's node kinds). */
export type CodeKind = "module" | "class" | "function" | "method" | "note";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Display label (basename without extension / folder name / tag / concept label). */
  label: string;
  /** True for pages with frontmatter `type: entity`. */
  entity: boolean;
  /** Frontmatter aliases — extra match targets for graph_query. */
  aliases: string[];
  /** code nodes only: symbol class. */
  codeKind?: CodeKind;
  /** code nodes only: source file (namespace-relative) and 1-based line. */
  file?: string;
  line?: number;
  /** code nodes only: signature snippet for display. */
  sig?: string;
}

/** "code" — an edge inside a code namespace (extracted from source, never agent-written). */
export type EdgeLayer = "derived" | "semantic" | "code";
export type Confidence = "extracted" | "inferred" | "ambiguous";

export interface GraphEdge {
  /** Node ids (directed as recorded; traversal treats edges as undirected). */
  src: string;
  tgt: string;
  /** Russian relation verb, e.g. "ссылается", "встраивает", "тег", or agent-supplied. */
  relation: string;
  confidence: Confidence;
  layer: EdgeLayer;
  /** For semantic edges: the note/source the claim came from, if recorded. */
  sourceNote?: string;
  /** For semantic edges: ISO date the edge was recorded (drives "what's new" in viewers). */
  created?: string;
}

/** Assembled, queryable in-memory graph (see assemble.ts). */
export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  /** Undirected adjacency: node id → incident edges with the far end pre-resolved. */
  adjacency: Map<string, { edge: GraphEdge; other: string }[]>;
  /** Degree above which a node is damped during traversal (hub guard, graphify-style). */
  hubThreshold: number;
  /** Count of malformed lines skipped while loading the semantic store. */
  semanticSkipped: number;
}

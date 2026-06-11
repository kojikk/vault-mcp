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
 */

export type NodeKind = "note" | "org" | "tag" | "concept";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Display label (basename without extension / folder name / tag / concept label). */
  label: string;
  /** True for pages with frontmatter `type: entity`. */
  entity: boolean;
  /** Frontmatter aliases — extra match targets for graph_query. */
  aliases: string[];
}

export type EdgeLayer = "derived" | "semantic";
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

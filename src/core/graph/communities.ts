import graphologyImport from "graphology";
import louvainImport from "graphology-communities-louvain";
import type { Graph } from "./types.js";

/** Minimal surface we use of graphology — keeps us honest about the dependency. */
interface MiniGraph {
  addNode(id: string): void;
  hasNode(id: string): boolean;
  addEdge(a: string, b: string): void;
  hasEdge(a: string, b: string): boolean;
  readonly order: number;
  readonly size: number;
}

// CJS/ESM interop: depending on which build Node resolves, the export may sit on .default.
const unwrap = <T,>(m: unknown): T => ((m as { default?: T }).default ?? m) as T;
const GraphCtor = unwrap<new (opts: { type: "undirected"; multi: boolean }) => MiniGraph>(graphologyImport);
const louvain = unwrap<(g: MiniGraph) => Record<string, number>>(louvainImport);

/**
 * Community detection + the analytics graphify surfaces in its reports:
 * god nodes (most-connected concepts) and bridges (community pairs joined by a single
 * edge — the "surprising connection" heuristic). Louvain stands in for graphify's
 * Leiden: at personal-vault scale the difference is cosmetic, and the implementation
 * is pure JS (no native binaries — security checklist).
 */

export interface CommunityReport {
  /** node id → community number. */
  assignment: Map<string, number>;
  count: number;
  /** Community pairs connected by exactly one edge: src/tgt are the bridging nodes. */
  bridges: { src: string; tgt: string; relation: string }[];
}

export function detectCommunities(graph: Graph): CommunityReport {
  // Tag nodes are intentionally excluded: a popular tag merges unrelated communities.
  const g = new GraphCtor({ type: "undirected", multi: false });
  for (const node of graph.nodes.values()) {
    if (node.kind !== "tag") g.addNode(node.id);
  }
  for (const e of graph.edges) {
    if (!g.hasNode(e.src) || !g.hasNode(e.tgt) || e.src === e.tgt) continue;
    if (!g.hasEdge(e.src, e.tgt)) g.addEdge(e.src, e.tgt);
  }

  if (g.order === 0 || g.size === 0) {
    return { assignment: new Map(), count: 0, bridges: [] };
  }

  const raw = louvain(g);
  const assignment = new Map<string, number>(Object.entries(raw));
  const count = new Set(assignment.values()).size;

  // Cross-community edge census → pairs with exactly one connecting edge.
  const crossing = new Map<string, { n: number; sample: { src: string; tgt: string; relation: string } }>();
  for (const e of graph.edges) {
    const a = assignment.get(e.src);
    const b = assignment.get(e.tgt);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const cur = crossing.get(key);
    if (cur) cur.n++;
    else crossing.set(key, { n: 1, sample: { src: e.src, tgt: e.tgt, relation: e.relation } });
  }
  const bridges = [...crossing.values()].filter((c) => c.n === 1).map((c) => c.sample);

  return { assignment, count, bridges };
}

/** Most-connected non-tag nodes ("god nodes"). */
export function godNodes(graph: Graph, top = 10): { id: string; degree: number }[] {
  const out: { id: string; degree: number }[] = [];
  for (const [id, incident] of graph.adjacency) {
    const node = graph.nodes.get(id);
    if (!node || node.kind === "tag") continue;
    if (incident.length > 0) out.push({ id, degree: incident.length });
  }
  return out.sort((a, b) => b.degree - a.degree).slice(0, top);
}

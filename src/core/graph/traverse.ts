import type { Graph, GraphEdge } from "./types.js";

/**
 * Graph traversal (graphify's BFS-with-budget principle).
 *
 * Edges are stored directed but traversed as undirected: the brain asks "what is X
 * connected to", not "what does X point at". Hub nodes (degree > graph.hubThreshold)
 * are entered but not expanded — exactly like graphify's p99 damping — so a god node
 * cannot flood the result with its entire neighborhood. Seeds are always expanded.
 */

export interface Subgraph {
  /** Node ids in BFS discovery order, with their depth from the nearest seed. */
  nodes: { id: string; depth: number }[];
  edges: GraphEdge[];
  /** True when expansion stopped because maxNodes was reached. */
  truncated: boolean;
}

export function bfsSubgraph(graph: Graph, seeds: string[], depth: number, maxNodes: number): Subgraph {
  const found = new Map<string, number>();
  const edges: GraphEdge[] = [];
  const edgeSeen = new Set<GraphEdge>();
  let truncated = false;

  const queue: { id: string; d: number }[] = [];
  for (const s of seeds) {
    if (graph.nodes.has(s) && !found.has(s)) {
      found.set(s, 0);
      queue.push({ id: s, d: 0 });
    }
  }

  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    if (d >= depth) continue;
    const isSeed = d === 0;
    const incident = graph.adjacency.get(id) ?? [];
    if (!isSeed && incident.length > graph.hubThreshold) continue; // damp hubs
    for (const { edge, other } of incident) {
      if (found.size >= maxNodes && !found.has(other)) {
        truncated = true;
        continue;
      }
      if (!found.has(other)) {
        found.set(other, d + 1);
        queue.push({ id: other, d: d + 1 });
      }
      if (!edgeSeen.has(edge) && found.has(edge.src) && found.has(edge.tgt)) {
        edgeSeen.add(edge);
        edges.push(edge);
      }
    }
  }

  return {
    nodes: [...found.entries()].map(([id, d]) => ({ id, depth: d })).sort((a, b) => a.depth - b.depth),
    edges,
    truncated,
  };
}

/** Shortest undirected path between two nodes, or null. BFS with a hop cap. */
export function shortestPath(graph: Graph, source: string, target: string, maxHops: number): GraphEdge[] | null {
  if (source === target) return [];
  if (!graph.nodes.has(source) || !graph.nodes.has(target)) return null;

  const prev = new Map<string, { from: string; edge: GraphEdge }>();
  const visited = new Set<string>([source]);
  let frontier = [source];
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const { edge, other } of graph.adjacency.get(id) ?? []) {
        if (visited.has(other)) continue;
        visited.add(other);
        prev.set(other, { from: id, edge });
        if (other === target) {
          const pathEdges: GraphEdge[] = [];
          let cur = target;
          while (cur !== source) {
            const step = prev.get(cur)!;
            pathEdges.unshift(step.edge);
            cur = step.from;
          }
          return pathEdges;
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return null;
}

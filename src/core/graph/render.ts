import type { Graph, GraphEdge } from "./types.js";
import type { Subgraph } from "./traverse.js";

/**
 * Text rendering of graph results for the model.
 *
 * Every label and relation originates in vault content (or agent-supplied edge text),
 * so rendered output is untrusted data — callers wrap it with wrapUntrusted. On top of
 * that, labels are sanitized here (graphify lesson F-010): no newlines, no [[ ]] that
 * could fabricate fake structure inside the rendered block, hard length cap.
 */

/** ≈ chars per token for mixed Russian/English text; used for the token budget. */
const CHARS_PER_TOKEN = 3;

export function sanitize(s: string, max = 80): string {
  const flat = s.replace(/[\r\n\t]+/g, " ").replace(/\[\[|\]\]/g, "").replace(/[<>`]/g, "'").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function nodeRef(graph: Graph, id: string): string {
  const node = graph.nodes.get(id);
  if (!node) return sanitize(id);
  switch (node.kind) {
    case "note":
      return `${sanitize(node.label)} (${sanitize(node.id, 120)})`;
    case "org":
      return `${sanitize(node.label)} (узел ${sanitize(node.id, 120)})`;
    case "tag":
      return sanitize(node.label);
    case "concept":
      return `${sanitize(node.label)} (концепт без страницы)`;
  }
}

function edgeLine(graph: Graph, e: GraphEdge): string {
  const conf = e.layer === "semantic" ? ` [${e.confidence}]` : "";
  return `- ${nodeRef(graph, e.src)} —${sanitize(e.relation, 60)}→ ${nodeRef(graph, e.tgt)}${conf}`;
}

export function renderSubgraph(graph: Graph, sub: Subgraph, tokenBudget: number): string {
  const budget = Math.max(200, tokenBudget) * CHARS_PER_TOKEN;
  const lines: string[] = [];
  let used = 0;
  let cut = false;
  const push = (line: string): boolean => {
    if (used + line.length + 1 > budget) {
      cut = true;
      return false;
    }
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  push(`УЗЛЫ (${sub.nodes.length}):`);
  for (const { id, depth } of sub.nodes) {
    if (!push(`- [d${depth}] ${nodeRef(graph, id)}`)) break;
  }
  if (!cut) {
    push("");
    push(`СВЯЗИ (${sub.edges.length}):`);
    // Semantic edges carry the brain's typed knowledge — render them before raw links.
    const ordered = [...sub.edges].sort((a, b) => (a.layer === b.layer ? 0 : a.layer === "semantic" ? -1 : 1));
    for (const e of ordered) {
      if (!push(edgeLine(graph, e))) break;
    }
  }
  if (cut || sub.truncated) {
    lines.push("(обрезано по бюджету — сузь вопрос или подними token_budget)");
  }
  return lines.join("\n");
}

export function renderPath(graph: Graph, edges: GraphEdge[]): string {
  if (edges.length === 0) return "(это один и тот же узел)";
  return edges.map((e) => edgeLine(graph, e)).join("\n");
}

export function renderNeighbors(graph: Graph, id: string, incident: { edge: GraphEdge; other: string }[]): string {
  const head = `${nodeRef(graph, id)} — ${incident.length} связь(ей):`;
  const lines = incident.map(({ edge, other }) => {
    const dir = edge.src === id ? "→" : "←";
    const conf = edge.layer === "semantic" ? ` [${edge.confidence}]` : "";
    return `- ${dir} ${sanitize(edge.relation, 60)} ${dir === "→" ? "к" : "от"} ${nodeRef(graph, other)}${conf} (${edge.layer})`;
  });
  return [head, ...lines].join("\n");
}

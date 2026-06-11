import type { Graph, GraphNode } from "./types.js";

/**
 * Natural-language → node matching (the graphify query principle, ported):
 * tokenize labels and aliases, weight rare tokens higher (IDF), add a strong bonus for
 * whole-phrase containment. No LLM here — the caller (an LLM) phrases the question;
 * this just finds the seeds cheaply and deterministically.
 *
 * Russian-specific normalization: lowercase, NFKD diacritic strip, ё→е. Morphology is
 * intentionally NOT stemmed in v1 (GRAPH-PLAN §13.1) — aliases in frontmatter are the
 * pressure valve for inflected forms.
 */

export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

export function tokenize(s: string): string[] {
  return normalizeLabel(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/** Tokens a node is findable by: label, aliases, and its path segments for note/org nodes. */
function nodeTokens(node: GraphNode): string[] {
  const parts = [node.label, ...node.aliases];
  if (node.kind === "note" || node.kind === "org") parts.push(node.id.replace(/\.md$/i, ""));
  return [...new Set(parts.flatMap(tokenize))];
}

export interface MatchHit {
  node: GraphNode;
  score: number;
}

export function matchNodes(graph: Graph, query: string, limit = 5): MatchHit[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];
  const queryNorm = normalizeLabel(query);

  // Document frequency over node token sets.
  const df = new Map<string, number>();
  const tokensByNode = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    const toks = nodeTokens(node);
    tokensByNode.set(node.id, toks);
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = Math.max(1, graph.nodes.size);
  const idf = (t: string): number => Math.log(1 + n / (1 + (df.get(t) ?? 0)));

  const hits: MatchHit[] = [];
  for (const node of graph.nodes.values()) {
    const toks = new Set(tokensByNode.get(node.id) ?? []);
    let score = 0;
    for (const qt of queryTokens) {
      if (toks.has(qt)) {
        score += idf(qt);
        continue;
      }
      // Prefix tolerance: "вишлист" matches "вишлиста" (cheap stand-in for stemming).
      for (const t of toks) {
        if (t.length >= 4 && qt.length >= 4 && (t.startsWith(qt) || qt.startsWith(t))) {
          score += idf(t) * 0.7;
          break;
        }
      }
    }
    if (score <= 0) continue;
    // Whole-phrase containment in label/alias is a much stronger signal than token overlap.
    const labelNorm = normalizeLabel(node.label);
    const aliasNorms = node.aliases.map(normalizeLabel);
    if (labelNorm === queryNorm || aliasNorms.includes(queryNorm)) score *= 3;
    else if (labelNorm.includes(queryNorm) || queryNorm.includes(labelNorm)) score *= 1.8;
    // Entity pages are the compiled knowledge — favor them slightly over tags/org scaffolding.
    if (node.entity) score *= 1.2;
    if (node.kind === "tag") score *= 0.8;
    hits.push({ node, score });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

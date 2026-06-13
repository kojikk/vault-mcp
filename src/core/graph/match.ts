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

/**
 * Split a programming identifier into its words: camelCase, PascalCase, snake_case,
 * kebab-case, and path separators all break. "scoreQuery" → ["score","query"],
 * "build_derived" → ["build","derived"], "src/core/match.ts#scoreQuery" → [...].
 * Lets a natural-language code question ("где скоринг запроса"/"score query") reach a
 * symbol whose name is a single glued token. KB matching never calls this.
 */
export function splitIdentifier(s: string): string[] {
  const out = new Set<string>();
  for (const chunk of s.split(/[^\p{L}\p{N}]+/u)) {
    if (!chunk) continue;
    // Break camel/Pascal humps: "scoreQuery" → "score Query", "HTTPServer" → "HTTP Server".
    const split = chunk
      .replace(/([a-zа-я0-9])([A-ZА-Я])/gu, "$1 $2")
      .replace(/([A-ZА-Я]+)([A-ZА-Я][a-zа-я])/gu, "$1 $2");
    for (const w of split.split(/\s+/)) {
      const t = normalizeLabel(w);
      if (t.length > 1) out.add(t);
    }
  }
  return [...out];
}

/** Tokens a node is findable by: label, aliases, and its path segments for note/org nodes. */
function nodeTokens(node: GraphNode, code: boolean): string[] {
  if (code) {
    // Code nodes: match on the symbol name, its identifier sub-words, and the file path.
    const parts = [node.label, node.id, ...(node.file ? [node.file] : []), ...(node.sig ? [node.sig] : [])];
    return [...new Set(parts.flatMap((p) => [...tokenize(p), ...splitIdentifier(p)]))];
  }
  const parts = [node.label, ...node.aliases];
  if (node.kind === "note" || node.kind === "org") parts.push(node.id.replace(/\.md$/i, ""));
  return [...new Set(parts.flatMap(tokenize))];
}

export interface MatchHit {
  node: GraphNode;
  score: number;
}

export function matchNodes(graph: Graph, query: string, limit = 5, opts?: { code?: boolean }): MatchHit[] {
  const code = opts?.code ?? false;
  // In code namespaces the IDF corpus is the project's own identifiers (a separate Graph),
  // so matching can never bleed between knowledge and code; we only widen tokenization.
  const queryTokens = [...new Set(code ? [...tokenize(query), ...splitIdentifier(query)] : tokenize(query))];
  if (queryTokens.length === 0) return [];
  const queryNorm = normalizeLabel(query);

  // Document frequency over node token sets.
  const df = new Map<string, number>();
  const tokensByNode = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    const toks = nodeTokens(node, code);
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

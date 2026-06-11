import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { VaultCore } from "../vault-core.js";
import { CoreError } from "../errors.js";

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

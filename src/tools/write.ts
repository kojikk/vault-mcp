import { z } from "zod";
import matter from "gray-matter";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, ToolResult } from "./context.js";
import { textResult, mapError } from "./context.js";
import { CoreError } from "../core/errors.js";
import type { IdempotencyLedger } from "./idempotency.js";

/**
 * Phase 2 — additive write tools. Per §5.2 these run autonomously (no confirm): they are
 * the hot "lay down a thought" path. Every write goes through core.mutate, so it is atomic,
 * locked, journaled and committed. None can delete; the worst case is extra content,
 * reverted with one `git revert` (lesson C-7 / triad leg 2).
 */
export function registerWriteTools(server: McpServer, ctx: ToolContext, ledger: IdempotencyLedger): void {
  const { core, log } = ctx;
  const additive = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  } as const;

  const idemKey = z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Optional client operation id; a replayed key is applied at most once.");

  async function applyIdempotent(
    key: string | undefined,
    run: () => Promise<string>,
  ): Promise<ToolResult> {
    if (key) {
      const prev = ledger.get(key);
      if (prev) return textResult(`(idempotent replay — not re-applied) ${prev}`);
    }
    const summary = await run();
    if (key) ledger.record(key, summary);
    return textResult(summary);
  }

  server.registerTool(
    "create_note",
    {
      title: "Create a new note",
      description:
        "Create a NEW markdown/canvas file (fails if it already exists). Run `search` first to avoid duplicates. Optional YAML frontmatter.",
      inputSchema: {
        path: z.string().describe("Vault-relative file path ending in .md or .canvas."),
        content: z.string().describe("File body (markdown)."),
        frontmatter: z.record(z.string(), z.unknown()).optional().describe("Optional YAML frontmatter key/values."),
        idempotency_key: idemKey,
      },
      annotations: additive,
    },
    async (args) => {
      try {
        return await applyIdempotent(args.idempotency_key, async () => {
          const body =
            args.frontmatter && Object.keys(args.frontmatter).length > 0
              ? matter.stringify(args.content, args.frontmatter)
              : args.content;
          await core.mutate({
            op: "create_note",
            message: `create_note: ${args.path}`,
            journal: { path: args.path },
            body: async (tx) => {
              if (tx.exists(args.path)) {
                throw new CoreError("ALREADY_EXISTS", "a file already exists at that path; use append/update instead");
              }
              tx.writeFile(args.path, body);
            },
          });
          return `created ${args.path}`;
        });
      } catch (err) {
        return mapError(err, log, "create_note");
      }
    },
  );

  server.registerTool(
    "append_to_home",
    {
      title: "Append to a node's _home.md",
      description:
        "Append text to a node's _home.md (creating it if absent). Use for small notes that belong inline. Larger notes should be separate files.",
      inputSchema: {
        node: z.string().describe("Vault-relative node folder, e.g. 'Milestone-A/Project-A1'."),
        text: z.string().describe("Markdown to append."),
        idempotency_key: idemKey,
      },
      annotations: additive,
    },
    async (args) => {
      try {
        return await applyIdempotent(args.idempotency_key, async () => {
          const homeRel = path.posix.join(args.node, "_home.md");
          await core.mutate({
            op: "append_to_home",
            message: `append_to_home: ${homeRel}`,
            journal: { node: args.node },
            body: async (tx) => {
              const prior = tx.exists(homeRel) ? tx.read(homeRel) : `# ${path.posix.basename(args.node)}\n`;
              const joined = prior.endsWith("\n") ? prior : prior + "\n";
              tx.writeFile(homeRel, joined + args.text.replace(/\s+$/, "") + "\n");
            },
          });
          return `appended to ${homeRel}`;
        });
      } catch (err) {
        return mapError(err, log, "append_to_home");
      }
    },
  );

  server.registerTool(
    "add_raw",
    {
      title: "Add a raw source to _raw/ (append-only)",
      description:
        "Save a TEXT source (pasted article, thought stream, document excerpt) into the append-only _raw/ inbox for later ingest. Writes a new timestamped .md with frontmatter; never edits existing raw. Binaries (PDF/images) are NOT added here — drop those into _attachments/ via the filesystem.",
      inputSchema: {
        content: z.string().min(1).describe("The raw source text to archive verbatim."),
        category: z
          .enum(["articles", "notes", "docs"])
          .optional()
          .describe("Subfolder under _raw/. Default 'notes'."),
        title: z.string().optional().describe("Human title; used for the filename slug and frontmatter."),
        source: z.string().optional().describe("Where it came from (URL or short description) — stored in frontmatter."),
        idempotency_key: idemKey,
      },
      annotations: additive,
    },
    async (args) => {
      try {
        return await applyIdempotent(args.idempotency_key, async () => {
          const category = args.category ?? "notes";
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const slug = slugify(args.title ?? "");
          const filename = slug ? `${stamp}-${slug}.md` : `${stamp}.md`;
          const rel = path.posix.join("_raw", category, filename);
          const fm: Record<string, unknown> = {
            ...(args.title ? { title: args.title } : {}),
            ...(args.source ? { source: args.source } : {}),
            date: new Date().toISOString().slice(0, 10),
            ingested: false,
          };
          const body = matter.stringify(args.content.replace(/\s+$/, "") + "\n", fm);
          await core.mutate({
            op: "add_raw",
            message: `add_raw: ${rel}`,
            journal: { path: rel, category },
            body: async (tx) => {
              if (tx.exists(rel)) {
                throw new CoreError("ALREADY_EXISTS", "a raw file already exists at that path; raw is append-only");
              }
              tx.writeFile(rel, body);
            },
          });
          return `added raw source ${rel} (ingested: false)`;
        });
      } catch (err) {
        return mapError(err, log, "add_raw");
      }
    },
  );

  // update_memory / update_index / update_hot share a "rewrite a root/node file" shape.
  const rewriteTool = (
    name: "update_memory" | "update_index" | "update_hot",
    title: string,
    description: string,
    targetFor: (args: { node?: string }) => string,
    extraInput: Record<string, z.ZodTypeAny>,
  ) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: { content: z.string().describe("Full new content (this REPLACES the file)."), idempotency_key: idemKey, ...extraInput },
        annotations: additive,
      },
      async (args) => {
        try {
          return await applyIdempotent(args.idempotency_key as string | undefined, async () => {
            const target = targetFor(args as { node?: string });
            await core.mutate({
              op: name,
              message: `${name}: ${target}`,
              journal: { target },
              body: async (tx) => {
                tx.writeFile(target, (args.content as string).replace(/\s+$/, "") + "\n");
              },
            });
            return `updated ${target}`;
          });
        } catch (err) {
          return mapError(err, log, name);
        }
      },
    );
  };

  rewriteTool(
    "update_memory",
    "Rewrite a node's _memory.md",
    "Replace a node's _memory.md with a fresh, compacted summary (≤~1–2 pages). Memory is rewritten, not appended.",
    (args) => path.posix.join(args.node ?? "", "_memory.md"),
    { node: z.string().describe("Vault-relative node folder.") },
  );

  rewriteTool(
    "update_index",
    "Rewrite the global manifest",
    "Replace _index.md (the manifest of all nodes). Edit after structural changes.",
    () => "_index.md",
    {},
  );

  rewriteTool(
    "update_hot",
    "Rewrite the hot cache",
    "Replace _hot.md (recent activity). Rewrite at the end of a capture/query session.",
    () => "_hot.md",
    {},
  );

  // ---- mark_raw_ingested (flip the frontmatter flag only; body stays append-only) ----
  server.registerTool(
    "mark_raw_ingested",
    {
      title: "Mark a _raw/ source as ingested",
      description:
        "Flip the `ingested` frontmatter flag of a _raw/ source to true AFTER you have integrated it into knowledge pages. Touches only the flag, never the body — _raw/ stays append-only. Closes the ingest loop so lint/planner can see what is still unprocessed.",
      inputSchema: {
        path: z.string().describe("Vault-relative path of the _raw/ file."),
        idempotency_key: idemKey,
      },
      annotations: additive,
    },
    async (args) => {
      try {
        return await applyIdempotent(args.idempotency_key, async () => {
          const rel = args.path;
          if (!isUnderRaw(rel)) throw new CoreError("INVALID_NAME", "path must be inside _raw/");
          await core.mutate({
            op: "mark_raw_ingested",
            message: `mark_raw_ingested: ${rel}`,
            journal: { path: rel },
            body: async (tx) => {
              if (!tx.exists(rel)) throw new CoreError("NOT_FOUND", "no such raw file");
              tx.writeFile(rel, setIngestedTrue(tx.read(rel)));
            },
          });
          return `marked ${rel} ingested: true`;
        });
      } catch (err) {
        return mapError(err, log, "mark_raw_ingested");
      }
    },
  );

  // ---- append_contradiction (one open row in _contradictions.md; schema matches lint) ----
  server.registerTool(
    "append_contradiction",
    {
      title: "Record a contradiction",
      description:
        "Append one row (status 'open') to _contradictions.md when a new source conflicts with recorded knowledge. Creates the table with its header if absent. The user resolves these manually; lint counts the open ones.",
      inputSchema: {
        concept: z.string().min(1).describe("The concept the two claims disagree about."),
        claim_a: z.string().min(1).describe("First claim."),
        source_a: z.string().min(1).describe("Where claim A came from."),
        claim_b: z.string().min(1).describe("Second, conflicting claim."),
        source_b: z.string().min(1).describe("Where claim B came from."),
        date: z.string().optional().describe("ISO date (defaults to today)."),
        idempotency_key: idemKey,
      },
      annotations: additive,
    },
    async (args) => {
      try {
        return await applyIdempotent(args.idempotency_key, async () => {
          const date = args.date ?? new Date().toISOString().slice(0, 10);
          const cells = [date, args.concept, args.claim_a, args.source_a, args.claim_b, args.source_b, "open"].map(cell);
          const row = `| ${cells.join(" | ")} |`;
          await core.mutate({
            op: "append_contradiction",
            message: `append_contradiction: ${cell(args.concept)}`,
            journal: { concept: cell(args.concept) },
            body: async (tx) => {
              const prior = tx.exists(CONTRADICTIONS_FILE) ? tx.read(CONTRADICTIONS_FILE) : CONTRADICTIONS_HEADER;
              const base = prior.endsWith("\n") ? prior : prior + "\n";
              tx.writeFile(CONTRADICTIONS_FILE, base + row + "\n");
            },
          });
          return `recorded contradiction for "${cell(args.concept)}" (status: open)`;
        });
      } catch (err) {
        return mapError(err, log, "append_contradiction");
      }
    },
  );
}

const CONTRADICTIONS_FILE = "_contradictions.md";
const CONTRADICTIONS_HEADER =
  "# Противоречия\n\n| Дата | Концепт | Утверждение A | Источник A | Утверждение B | Источник B | Статус |\n|---|---|---|---|---|---|---|\n";

/**
 * Flip the `ingested` frontmatter flag to true by patching the exact line, never
 * re-serializing the document: round-tripping through a YAML emitter rewrites quoting,
 * date formats and leading whitespace, which breaks the "_raw is byte-stable" contract.
 * A raw file dropped in by hand without frontmatter gets a minimal block prepended.
 */
function setIngestedTrue(content: string): string {
  const fm = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!fm) return `---\ningested: true\n---\n${content}`;
  const [whole, open, body, close] = fm as unknown as [string, string, string, string];
  const flagLine = /^(ingested\s*:).*$/m;
  const newBody = flagLine.test(body) ? body.replace(flagLine, "$1 true") : `${body}\ningested: true`;
  const patched = open + newBody + close + content.slice(whole.length);
  // Defense in depth: the patched frontmatter must still parse with the flag set.
  if ((matter(patched).data as Record<string, unknown>).ingested !== true) {
    throw new CoreError("INVALID_NAME", "could not set the ingested flag in this file's frontmatter");
  }
  return patched;
}

/** True if a vault-relative path is inside the append-only _raw/ inbox. */
function isUnderRaw(rel: string): boolean {
  const p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return p === "_raw" || p.startsWith("_raw/");
}

/** Sanitise a value for a markdown table cell (no pipes/newlines break the row). */
function cell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** Build a filesystem-safe slug from a title (keeps unicode letters/digits, caps length). */
function slugify(title: string): string {
  return title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

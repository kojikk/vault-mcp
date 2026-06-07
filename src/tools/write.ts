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
}

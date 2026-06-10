import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, ToolResult } from "./context.js";
import { textResult, mapError } from "./context.js";
import { CoreError } from "../core/errors.js";
import type { VaultCore, TreeNode } from "../core/vault-core.js";
import { planBacklinkFixes, countInboundLinks, type Rename } from "../core/backlinks.js";

/**
 * Phase 3 — structural & destructive tools. Per §5.2 these are two-step: with confirm=false
 * (default) they return a PLAN (dry-run) and change nothing; with confirm=true they execute
 * inside a single core.mutate transaction (atomic, locked, journaled, committed, rollback on
 * error). Obsidian backlinks are repaired as part of move/promote. soft_delete only ever
 * moves into .trash/ (no hard delete anywhere — triad leg 2).
 */
export function registerStructuralTools(server: McpServer, ctx: ToolContext): void {
  const { core, log } = ctx;
  const structural = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

  // ---- create_node (purely additive; no confirm needed) ----
  server.registerTool(
    "create_node",
    {
      title: "Create a node",
      description:
        "Create a new node folder with _home.md and _memory.md scaffolding. Use when a thought needs a new home (project/milestone/cluster).",
      inputSchema: {
        path: z.string().describe("Vault-relative folder path for the new node."),
        title: z.string().optional().describe("Human title; defaults to the folder name."),
        type: z.enum(["milestone", "project", "cluster"]).optional().describe("Node type for the manifest."),
        summary: z.string().optional().describe("One-line summary for _memory/_index."),
      },
      annotations: structural,
    },
    async (args) => {
      try {
        const title = args.title ?? path.posix.basename(args.path);
        const type = args.type ?? "project";
        const summary = args.summary ?? "";
        const homeRel = path.posix.join(args.path, "_home.md");
        const memRel = path.posix.join(args.path, "_memory.md");
        await core.mutate({
          op: "create_node",
          message: `create_node: ${args.path}`,
          journal: { path: args.path, type },
          body: async (tx) => {
            if (tx.exists(homeRel)) throw new CoreError("ALREADY_EXISTS", "node already exists");
            tx.mkdir(args.path);
            tx.writeFile(homeRel, `# ${title}\n\n> ${summary}\n\nType: ${type}\n`);
            tx.writeFile(
              memRel,
              `# ${title} — memory\n\nСуть: ${summary}\nРешения: —\nОткрытые нити: —\nКлючевые ссылки: —\nОбновлено: ${new Date().toISOString().slice(0, 10)}\n`,
            );
          },
        });
        return textResult(`created node ${args.path} (type=${type})`);
      } catch (err) {
        return mapError(err, log, "create_node");
      }
    },
  );

  // ---- move (+ backlink repair) ----
  server.registerTool(
    "move",
    {
      title: "Move/rename a node or file (repairs backlinks)",
      description:
        "Move or rename a file or node folder and repair Obsidian backlinks across the vault. Returns a dry-run plan unless confirm=true.",
      inputSchema: {
        from: z.string().describe("Vault-relative source path (file or folder)."),
        to: z.string().describe("Vault-relative destination path."),
        confirm: z.boolean().optional().describe("Set true to apply. Default false = dry-run plan only."),
      },
      annotations: structural,
    },
    async (args) => {
      try {
        // Surface a destination clash already in the dry-run (the core enforces this too);
        // a pure case-rename is allowed — on a case-insensitive FS the "existing" path is
        // the source itself.
        if (core.pathExists(args.to) && args.from.toLowerCase() !== args.to.toLowerCase()) {
          throw new CoreError("ALREADY_EXISTS", "destination already exists; refusing to overwrite");
        }
        const { renames, excluded } = computeRenames(core, args.from, args.to);
        const edits = planBacklinkFixes(core, renames, excluded);
        if (!args.confirm) {
          return textResult(
            planText("move", {
              moves: renames.map((r) => `${r.fromRel} → ${r.toRel}`),
              backlinkEdits: edits.map((e) => `${e.file} (${e.replacements})`),
            }),
          );
        }
        await core.mutate({
          op: "move",
          message: `move: ${args.from} → ${args.to}`,
          journal: { from: args.from, to: args.to, backlinkFiles: edits.length },
          body: async (tx) => {
            tx.move(args.from, args.to);
            // Recompute against the post-move tree but with the same exclude set, so the
            // applied edits match the plan exactly.
            for (const e of planBacklinkFixes(core, renames, excluded)) {
              tx.writeFile(e.file, e.newContent);
            }
          },
        });
        return textResult(`moved ${args.from} → ${args.to}; repaired backlinks in ${edits.length} file(s)`);
      } catch (err) {
        return mapError(err, log, "move");
      }
    },
  );

  // ---- promote (project -> container) ----
  server.registerTool(
    "promote",
    {
      title: "Promote a project into a container",
      description:
        "Promote a project node into a container by moving listed files into named child nodes (with backlink repair) and leaving a pointer behind. One transaction. Dry-run unless confirm=true.",
      inputSchema: {
        node: z.string().describe("Vault-relative project folder to promote."),
        children: z
          .array(
            z.object({
              name: z.string().describe("Child node folder name (created under the node)."),
              files: z.array(z.string()).describe("Vault-relative files (currently under the node) to move into this child."),
            }),
          )
          .min(1)
          .describe("Mapping of new child nodes to the files they should contain."),
        confirm: z.boolean().optional().describe("Set true to apply. Default false = dry-run plan."),
      },
      annotations: structural,
    },
    async (args) => {
      try {
        const nodePrefix = args.node.replace(/\/+$/, "") + "/";
        const renames: Rename[] = [];
        const excluded = new Set<string>();
        const childInits: { home: string; mem: string; name: string }[] = [];

        for (const child of args.children) {
          const childDir = path.posix.join(args.node, child.name);
          childInits.push({
            home: path.posix.join(childDir, "_home.md"),
            mem: path.posix.join(childDir, "_memory.md"),
            name: child.name,
          });
          for (const f of child.files) {
            if (!f.startsWith(nodePrefix)) {
              throw new CoreError("INVALID_NAME", `file ${f} is not inside ${args.node}`);
            }
            if (!f.toLowerCase().endsWith(".md")) {
              throw new CoreError("BAD_EXTENSION", `only .md files can be promoted: ${f}`);
            }
            const toRel = path.posix.join(childDir, path.posix.basename(f));
            renames.push({ fromRel: f, toRel });
            excluded.add(f);
          }
        }
        const edits = planBacklinkFixes(core, renames, excluded);

        if (!args.confirm) {
          return textResult(
            planText("promote", {
              newChildren: childInits.map((c) => c.name),
              moves: renames.map((r) => `${r.fromRel} → ${r.toRel}`),
              backlinkEdits: edits.map((e) => `${e.file} (${e.replacements})`),
              pointer: `${path.posix.join(args.node, "_home.md")} gets a children index`,
            }),
          );
        }

        await core.mutate({
          op: "promote",
          message: `promote: ${args.node}`,
          journal: { node: args.node, children: childInits.map((c) => c.name), moved: renames.length },
          body: async (tx) => {
            for (const c of childInits) {
              const dir = path.posix.dirname(c.home);
              tx.mkdir(dir);
              if (!tx.exists(c.home)) tx.writeFile(c.home, `# ${c.name}\n\nType: project\n`);
              if (!tx.exists(c.mem)) tx.writeFile(c.mem, `# ${c.name} — memory\n\nОбновлено: ${new Date().toISOString().slice(0, 10)}\n`);
            }
            for (const r of renames) tx.move(r.fromRel, r.toRel);
            for (const e of planBacklinkFixes(core, renames, excluded)) tx.writeFile(e.file, e.newContent);
            // Pointer/local index in the (now container) node home.
            const homeRel = path.posix.join(args.node, "_home.md");
            const prior = tx.exists(homeRel) ? tx.read(homeRel) : `# ${path.posix.basename(args.node)}\n`;
            const index = childInits.map((c) => `- [[${path.posix.join(args.node, c.name, "_home")}|${c.name}]]`).join("\n");
            tx.writeFile(homeRel, `${prior.endsWith("\n") ? prior : prior + "\n"}\n## Подузлы\n${index}\n`);
          },
        });
        return textResult(`promoted ${args.node}: ${childInits.length} child node(s), moved ${renames.length} file(s), repaired ${edits.length} file(s)`);
      } catch (err) {
        return mapError(err, log, "promote");
      }
    },
  );

  // ---- soft_delete (-> .trash) ----
  server.registerTool(
    "soft_delete",
    {
      title: "Soft-delete to .trash (restorable)",
      description:
        "Move a file or node into .trash/ (restorable via git). NEVER a hard delete. Returns a dry-run plan with inbound-link warnings unless confirm=true.",
      inputSchema: {
        path: z.string().describe("Vault-relative file or folder to trash."),
        confirm: z.boolean().optional().describe("Set true to apply. Default false = dry-run plan."),
      },
      annotations: destructive,
    },
    async (args) => {
      try {
        const kind = core.statKind(args.path);
        const inbound = kind === "file" ? countInboundLinks(core, args.path) : descendantMdFiles(core, args.path).reduce((n, f) => n + countInboundLinks(core, f), 0);
        if (!args.confirm) {
          return textResult(
            planText("soft_delete", {
              target: `${args.path} (${kind})`,
              warning: inbound > 0 ? `${inbound} inbound link(s) will dangle until restored` : "no inbound links",
              note: "moves into .trash/<timestamp>/… — fully restorable",
            }),
          );
        }
        let dest = "";
        await core.mutate({
          op: "soft_delete",
          message: `soft_delete: ${args.path}`,
          journal: { path: args.path, kind, inbound },
          body: async (tx) => {
            dest = tx.trash(args.path);
          },
        });
        return textResult(`moved ${args.path} → ${dest} (restorable). Inbound links left intact: ${inbound}`);
      } catch (err) {
        return mapError(err, log, "soft_delete");
      }
    },
  );
}

// --------------------------- helpers ---------------------------

function descendantMdFiles(core: VaultCore, dirRel: string): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.type === "file") {
      if (n.path.toLowerCase().endsWith(".md")) out.push(n.path);
    } else if (n.children) {
      for (const c of n.children) walk(c);
    }
  };
  walk(core.listTree({ rel: dirRel, includeFiles: true }));
  return out;
}

/** Build the rename set + exclude set for a file-or-folder move. */
function computeRenames(core: VaultCore, from: string, to: string): { renames: Rename[]; excluded: Set<string> } {
  const kind = core.statKind(from);
  const renames: Rename[] = [];
  const excluded = new Set<string>();
  if (kind === "file") {
    renames.push({ fromRel: from, toRel: to });
    excluded.add(from);
  } else {
    const fromPrefix = from.replace(/\/+$/, "");
    const toPrefix = to.replace(/\/+$/, "");
    for (const f of descendantMdFiles(core, from)) {
      const suffix = f.slice(fromPrefix.length).replace(/^\//, "");
      const toRel = path.posix.join(toPrefix, suffix);
      renames.push({ fromRel: f, toRel });
      excluded.add(f);
    }
  }
  return { renames, excluded };
}

function planText(op: string, plan: Record<string, unknown>): string {
  return `DRY-RUN (${op}). Nothing changed. Re-run with confirm=true to apply.\n${JSON.stringify(plan, null, 2)}`;
}

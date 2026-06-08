import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { textResult, mapError } from "./context.js";
import { CoreError } from "../core/errors.js";
import type { IdempotencyLedger } from "./idempotency.js";

/**
 * Phase 4 — anchored edit. Unlike the additive write tools (which can only *add* content and
 * therefore run without confirm), edit_note can OVERWRITE or DELETE existing text, so it is
 * gated like the structural tools: confirm=false (default) returns a dry-run diff and changes
 * nothing; confirm=true applies inside one core.mutate (atomic, locked, journaled, committed,
 * rollback on error — git revert remains the escape hatch, triad leg 2).
 *
 * Safety rails:
 *  - Anchored replace, never offsets: old_string must occur exactly expected_occurrences times
 *    (default 1) or NOTHING changes — this kills "silently edited the wrong place".
 *  - Never renames a file (use `move`, which repairs backlinks). String edits keep the filename,
 *    so inbound [[wikilinks]] stay valid.
 *  - The audit journal (_log.md) is owned by the core and cannot be edited here.
 *  - Cache/context files (_memory/_index/_hot/_home) ARE editable on purpose, so the brain can
 *    refresh the compiled view in the same breath as recording new knowledge.
 */

const LOG_FILE = "_log.md";
/** Warn in the plan when an edit removes more than this fraction of the file. */
const BIG_DELETE_FRACTION = 0.5;
/** Max occurrences rendered in a dry-run diff (the rest are summarised). */
const MAX_DIFF_HUNKS = 5;
/** Context characters shown on each side of a change in the diff. */
const DIFF_CONTEXT = 40;

export function registerEditTools(server: McpServer, ctx: ToolContext, ledger: IdempotencyLedger): void {
  const { core, log } = ctx;
  const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

  server.registerTool(
    "edit_note",
    {
      title: "Edit an existing file via anchored replace (two-step)",
      description:
        "Replace an exact substring (old_string) with new_string in an EXISTING vault file. old_string must occur exactly expected_occurrences times (default 1) or nothing changes. Returns a dry-run diff unless confirm=true. Cannot rename files (use `move`) and cannot edit _log.md or _raw/ bodies. Use this to UPDATE existing pages and to refresh cache files (_memory/_index/_hot).",
      inputSchema: {
        path: z.string().describe("Vault-relative .md/.canvas file to edit (must already exist)."),
        old_string: z.string().min(1).describe("Exact text to find. Must be unique unless expected_occurrences is set."),
        new_string: z.string().describe("Replacement text. May be empty to delete the matched text."),
        expected_occurrences: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("How many times old_string must occur (default 1). All occurrences are replaced."),
        confirm: z.boolean().optional().describe("Set true to apply. Default false = dry-run diff only."),
        idempotency_key: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional client operation id; a replayed key is applied at most once."),
      },
      annotations: destructive,
    },
    async (args) => {
      try {
        if (args.idempotency_key) {
          const prev = ledger.get(args.idempotency_key);
          if (prev) return textResult(`(idempotent replay — not re-applied) ${prev}`);
        }

        const rel = args.path;
        if (isLogFile(rel)) {
          throw new CoreError("RESERVED_PATH", "_log.md is the append-only audit journal and cannot be edited");
        }
        if (isUnderRaw(rel)) {
          throw new CoreError("RESERVED_PATH", "_raw/ is append-only; edit its body is not allowed (use mark_raw_ingested for the flag)");
        }

        // readTextFile validates existence, confinement and that it is a file (NOT_FOUND / NOT_A_FILE).
        const before = core.readTextFile(rel);
        const occ = countOccurrences(before, args.old_string);
        const expected = args.expected_occurrences ?? 1;
        if (occ === 0) {
          throw new CoreError("NOT_FOUND", "old_string was not found in the file");
        }
        if (occ !== expected) {
          throw new CoreError(
            "INVALID_NAME",
            `old_string occurs ${occ} time(s) but expected ${expected}; refine old_string or set expected_occurrences`,
          );
        }
        if (args.new_string === args.old_string) {
          throw new CoreError("INVALID_NAME", "new_string is identical to old_string; nothing to change");
        }

        const after = replaceAll(before, args.old_string, args.new_string);
        const delta = after.length - before.length;
        const warn = bigDeletionWarning(before.length, delta);

        if (!args.confirm) {
          return textResult(planText(rel, occ, delta, before, args.old_string, args.new_string, warn));
        }

        await core.mutate({
          op: "edit_note",
          message: `edit_note: ${rel}`,
          journal: { path: rel, occurrences: occ, delta },
          body: async (tx) => {
            tx.writeFile(rel, after);
          },
        });

        const summary = `edited ${rel}: replaced ${occ} occurrence(s), net ${delta >= 0 ? "+" : ""}${delta} chars`;
        if (args.idempotency_key) ledger.record(args.idempotency_key, summary);
        return textResult(warn ? `${summary}\n${warn}` : summary);
      } catch (err) {
        return mapError(err, log, "edit_note");
      }
    },
  );
}

// --------------------------- helpers ---------------------------

function isLogFile(rel: string): boolean {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "") === LOG_FILE;
}

function isUnderRaw(rel: string): boolean {
  const p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return p === "_raw" || p.startsWith("_raw/");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

function bigDeletionWarning(beforeLen: number, delta: number): string | null {
  if (delta < 0 && beforeLen > 0 && Math.abs(delta) > beforeLen * BIG_DELETE_FRACTION) {
    return `WARNING: this removes ${Math.abs(delta)} of ${beforeLen} chars (~${Math.round((Math.abs(delta) / beforeLen) * 100)}%). Reversible via git, but double-check the target.`;
  }
  return null;
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\n/g, "\\n");
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/** Render up to MAX_DIFF_HUNKS in-line change snippets with surrounding context. */
function renderDiff(before: string, oldStr: string, newStr: string): string {
  const hunks: string[] = [];
  let idx = before.indexOf(oldStr);
  let shown = 0;
  while (idx !== -1 && shown < MAX_DIFF_HUNKS) {
    const ctxBefore = before.slice(Math.max(0, idx - DIFF_CONTEXT), idx);
    const ctxAfter = before.slice(idx + oldStr.length, idx + oldStr.length + DIFF_CONTEXT);
    hunks.push(`…${truncate(ctxBefore, 40)}[-${truncate(oldStr)}-]{+${truncate(newStr)}+}${truncate(ctxAfter, 40)}…`);
    idx = before.indexOf(oldStr, idx + oldStr.length);
    shown++;
  }
  return hunks.join("\n");
}

function planText(
  rel: string,
  occ: number,
  delta: number,
  before: string,
  oldStr: string,
  newStr: string,
  warn: string | null,
): string {
  const head = `DRY-RUN (edit_note). Nothing changed. Re-run with confirm=true to apply.`;
  const meta = `file: ${rel}\noccurrences: ${occ}\nnet change: ${delta >= 0 ? "+" : ""}${delta} chars`;
  const extra = occ > MAX_DIFF_HUNKS ? `\n(showing first ${MAX_DIFF_HUNKS} of ${occ} changes)` : "";
  return `${head}\n${meta}${warn ? `\n${warn}` : ""}\n--- changes ---\n${renderDiff(before, oldStr, newStr)}${extra}`;
}

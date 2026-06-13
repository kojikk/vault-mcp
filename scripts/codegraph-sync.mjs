#!/usr/bin/env node
/**
 * codegraph-sync — turn a project's code graph into an isolated vault code namespace.
 *
 * GRAPH-PLAN-CODE.md §4. This runs on the HOST, outside vault-mcp: tree-sitter / graphify
 * never enter the server (its security model is "pure TS, no egress, one child process —
 * ripgrep"). The script reads a code graph, maps it to our JSONL schema, atomically replaces
 * _system/graph/code/<project>.jsonl in the vault, and commits — preserving the git audit
 * trail without going through the MCP write path (the server only ever READS these files).
 *
 * Two extraction sources:
 *   --from graphify   (default) read <repo>/graphify-out/graph.json produced by `graphify .`
 *                     — the rich path (calls, inheritance, NOTE/WHY comments via tree-sitter).
 *   --from ts-naive   dependency-free fallback: a light scan of *.ts/*.js for modules,
 *                     functions, classes, imports and defines. No call edges. Use when
 *                     graphify is not installed; still enough to orient the model in a project.
 *
 * Usage:
 *   node scripts/codegraph-sync.mjs --project <name> --vault <vaultRoot> [--repo <root>]
 *        [--from graphify|ts-naive] [--graphify-out <path>] [--no-commit]
 *
 * Project name must match [a-z0-9][a-z0-9-]* (it becomes a filename + the ns id).
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ----------------------------- args -----------------------------

function parseArgs(argv) {
  const out = { from: "graphify", commit: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--project") out.project = next();
    else if (a === "--vault") out.vault = next();
    else if (a === "--repo") out.repo = next();
    else if (a === "--from") out.from = next();
    else if (a === "--graphify-out") out.graphifyOut = next();
    else if (a === "--no-commit") out.commit = false;
    else if (a === "-h" || a === "--help") out.help = true;
    else die(`unknown argument: ${a}`);
  }
  return out;
}

function die(msg) {
  process.stderr.write(`codegraph-sync: ${msg}\n`);
  process.exit(1);
}

const HELP = `codegraph-sync — sync a project's code graph into a vault code namespace.

  --project <name>     required; [a-z0-9][a-z0-9-]* — the namespace id (code:<name>)
  --vault <path>       required; the Obsidian vault root
  --repo <path>        project root to scan / find graphify-out (default: cwd)
  --from <src>         graphify (default) | ts-naive
  --graphify-out <p>   path to graph.json (default: <repo>/graphify-out/graph.json)
  --no-commit          write the file but do not git-commit in the vault
`;

// ----------------------------- mapping helpers -----------------------------

const NODE_KINDS = new Set(["module", "class", "function", "method", "note"]);

/** Normalize an arbitrary kind label from graphify to our CodeKind, or null to drop. */
function normalizeKind(raw) {
  if (!raw) return null;
  const k = String(raw).toLowerCase();
  if (k.includes("method")) return "method";
  if (k.includes("class") || k.includes("interface") || k.includes("struct") || k.includes("enum")) return "class";
  if (k.includes("func") || k.includes("fn") || k.includes("def")) return "function";
  if (k.includes("module") || k.includes("file")) return "module";
  if (k.includes("note") || k.includes("comment")) return "note";
  // variables / imports / misc symbols are intentionally dropped: they inflate the graph
  // without helping orientation (GRAPH-PLAN-CODE.md keeps namespaces lean).
  return null;
}

/** Normalize a graphify relationship label to our short relation verb. */
function normalizeRel(raw) {
  if (!raw) return "mentions";
  const r = String(raw).toLowerCase();
  if (r.includes("call")) return "calls";
  if (r.includes("import") || r.includes("require")) return "imports";
  if (r.includes("inherit") || r.includes("extend") || r.includes("subclass")) return "extends";
  if (r.includes("implement")) return "extends";
  if (r.includes("define") || r.includes("declare") || r.includes("contain")) return "defines";
  return "mentions";
}

function normalizeConf(raw) {
  const c = String(raw ?? "extracted").toLowerCase();
  if (c.startsWith("infer")) return "inferred";
  if (c.startsWith("ambig")) return "ambiguous";
  return "extracted";
}

const toPosix = (p) => p.split(path.sep).join("/");

/** Build the stable, human-readable node id: "<file>#<symbol>" or "<file>" for a module. */
function nodeId(file, symbol, kind) {
  const f = file ? toPosix(file) : "";
  if (kind === "module" || !symbol) return f || symbol || "";
  return f ? `${f}#${symbol}` : symbol;
}

// ----------------------------- source: graphify -----------------------------

function fromGraphify(graphifyOut) {
  if (!existsSync(graphifyOut)) {
    die(`graphify graph not found at ${graphifyOut}. Run \`graphify .\` in the project first, or use --from ts-naive.`);
  }
  let json;
  try {
    json = JSON.parse(readFileSync(graphifyOut, "utf8"));
  } catch (err) {
    die(`could not parse ${graphifyOut}: ${err.message}`);
  }

  // graphify's exact shape varies by version; accept the common variants tolerantly.
  const rawNodes = json.nodes ?? json.entities ?? [];
  const rawEdges = json.edges ?? json.relationships ?? json.relations ?? [];

  const nodes = [];
  const idByGraphify = new Map(); // graphify id → our id, so edges can be remapped
  for (const n of rawNodes) {
    const kind = normalizeKind(n.kind ?? n.type ?? n.category);
    if (!kind) continue;
    const file = n.file ?? n.path ?? n.filename ?? n.location?.file;
    const symbol = n.name ?? n.symbol ?? n.label ?? n.title;
    const line = n.line ?? n.start_line ?? n.startLine ?? n.location?.line;
    const sig = n.signature ?? n.sig ?? n.snippet;
    const id = nodeId(file, symbol, kind);
    if (!id) continue;
    if (n.id !== undefined) idByGraphify.set(String(n.id), id);
    idByGraphify.set(id, id);
    nodes.push({
      t: "node",
      id,
      kind,
      ...(file ? { file: toPosix(file) } : {}),
      ...(Number.isFinite(line) ? { line: Number(line) } : {}),
      ...(sig ? { sig: String(sig).slice(0, 400) } : {}),
    });
  }

  const remap = (ref) => {
    if (ref === undefined || ref === null) return null;
    const s = String(ref);
    return idByGraphify.get(s) ?? (idByGraphify.has(s) ? s : null);
  };

  const edges = [];
  for (const e of rawEdges) {
    const src = remap(e.source ?? e.src ?? e.from);
    const tgt = remap(e.target ?? e.tgt ?? e.to);
    if (!src || !tgt || src === tgt) continue;
    edges.push({
      t: "edge",
      src,
      tgt,
      rel: normalizeRel(e.relation ?? e.type ?? e.kind ?? e.label),
      conf: normalizeConf(e.confidence ?? e.conf),
    });
  }
  return { nodes, edges, generator: "graphify+codegraph-sync" };
}

// ----------------------------- source: ts-naive -----------------------------

const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".obsidian"]);

function walkSource(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
      } else if (e.isFile() && SCAN_EXTS.has(path.extname(e.name).toLowerCase()) && !e.name.endsWith(".d.ts")) {
        out.push(abs);
      }
    }
  };
  walk(root);
  return out;
}

/** Light declaration scan. No AST: regexes over lines. Captures the orientation skeleton. */
function fromTsNaive(repo) {
  // Prefer src/ if present; otherwise scan the whole repo.
  const scanRoot = existsSync(path.join(repo, "src")) ? path.join(repo, "src") : repo;
  const files = walkSource(scanRoot);
  const nodes = [];
  const edges = [];
  const moduleIds = new Set();

  const declRes = [
    { re: /^export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { re: /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { re: /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "function" },
    { re: /^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  ];

  for (const abs of files) {
    const rel = toPosix(path.relative(repo, abs));
    const moduleNodeId = nodeId(rel, null, "module");
    moduleIds.add(moduleNodeId);
    nodes.push({ t: "node", id: moduleNodeId, kind: "module", file: rel });

    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    const importTargets = new Set();
    const declaredHere = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // imports: capture the module specifier of `import ... from "X"` and `from 'X'`.
      const imp = /(?:^import\b[^'"]*from\s*|^export\b[^'"]*from\s*)['"]([^'"]+)['"]/.exec(line);
      if (imp) importTargets.add(imp[1]);

      const trimmed = line.replace(/^\s+/, "");
      for (const { re, kind } of declRes) {
        const m = re.exec(trimmed);
        if (m) {
          const sym = m[1];
          const key = `${sym}`;
          if (declaredHere.has(key)) break;
          declaredHere.add(key);
          const id = nodeId(rel, sym, kind);
          nodes.push({ t: "node", id, kind, file: rel, line: i + 1 });
          edges.push({ t: "edge", src: moduleNodeId, tgt: id, rel: "defines", conf: "extracted" });
          break;
        }
      }
    }

    // imports → module edges, resolved against scanned files (local relative imports only).
    for (const spec of importTargets) {
      if (!spec.startsWith(".")) continue; // skip bare/external specifiers
      const resolved = resolveLocalImport(abs, spec, repo, moduleIds);
      if (resolved && resolved !== moduleNodeId) {
        edges.push({ t: "edge", src: moduleNodeId, tgt: resolved, rel: "imports", conf: "extracted" });
      }
    }
  }

  return { nodes, edges, generator: "ts-naive+codegraph-sync" };
}

/** Resolve a relative ESM import (".js" extension or extensionless) to a scanned module id. */
function resolveLocalImport(fromAbs, spec, repo, moduleIds) {
  const baseAbs = path.resolve(path.dirname(fromAbs), spec);
  const baseRel = toPosix(path.relative(repo, baseAbs));
  // ESM TS uses .js in import paths that map to .ts sources; try a few endings.
  const candidates = [
    baseRel,
    baseRel.replace(/\.js$/, ".ts"),
    baseRel.replace(/\.jsx$/, ".tsx"),
    `${baseRel}.ts`,
    `${baseRel}.tsx`,
    `${baseRel}/index.ts`,
  ];
  for (const c of candidates) {
    if (moduleIds.has(c)) return c;
  }
  return null;
}

// ----------------------------- git -----------------------------

function gitShortCommit(repo) {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function gitCommit(vault, relFile, project, commit) {
  try {
    execFileSync("git", ["-C", vault, "add", "--", relFile], { encoding: "utf8" });
    const msg = `codegraph: ${project}${commit ? ` @ ${commit}` : ""}`;
    execFileSync("git", ["-C", vault, "commit", "-m", msg, "--", relFile], { encoding: "utf8" });
    return true;
  } catch (err) {
    // "nothing to commit" is fine (snapshot unchanged); anything else is a real warning.
    const out = String(err.stdout ?? "") + String(err.stderr ?? "");
    if (/nothing to commit|no changes added/i.test(out)) return false;
    process.stderr.write(`codegraph-sync: git commit skipped: ${out.trim() || err.message}\n`);
    return false;
  }
}

// ----------------------------- main -----------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!args.project) die("--project is required");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.project)) die(`invalid --project '${args.project}': must match [a-z0-9][a-z0-9-]*`);
  if (!args.vault) die("--vault is required");
  const vault = path.resolve(args.vault);
  if (!existsSync(vault) || !statSync(vault).isDirectory()) die(`vault not found: ${vault}`);
  const repo = path.resolve(args.repo ?? process.cwd());
  if (!existsSync(repo)) die(`repo not found: ${repo}`);

  const commit = gitShortCommit(repo);

  let result;
  if (args.from === "graphify") {
    result = fromGraphify(args.graphifyOut ?? path.join(repo, "graphify-out", "graph.json"));
  } else if (args.from === "ts-naive") {
    result = fromTsNaive(repo);
  } else {
    die(`unknown --from '${args.from}': use graphify or ts-naive`);
  }

  if (result.nodes.length === 0) die("extraction produced 0 nodes — nothing to write");

  const meta = {
    t: "meta",
    project: args.project,
    ...(originRemote(repo) ? { repo: originRemote(repo) } : {}),
    ...(commit ? { commit } : {}),
    scanned: new Date().toISOString().slice(0, 10),
    generator: result.generator,
  };

  const jsonl =
    [JSON.stringify(meta), ...result.nodes.map((n) => JSON.stringify(n)), ...result.edges.map((e) => JSON.stringify(e))].join("\n") +
    "\n";

  const relFile = `_system/graph/code/${args.project}.jsonl`;
  const absFile = path.join(vault, relFile);
  mkdirSync(path.dirname(absFile), { recursive: true });
  const tmp = `${absFile}.tmp`;
  writeFileSync(tmp, jsonl, "utf8");
  renameSync(tmp, absFile); // atomic replace — readers never see a half-written snapshot

  let committed = false;
  if (args.commit) committed = gitCommit(vault, relFile, args.project, commit);

  process.stdout.write(
    `codegraph-sync: wrote ${relFile} — ${result.nodes.length} nodes, ${result.edges.length} edges` +
      `${commit ? ` @ ${commit}` : ""} (${result.generator})${committed ? ", committed" : ""}\n`,
  );
}

function originRemote(repo) {
  try {
    const url = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    return url.replace(/^https?:\/\//, "").replace(/\.git$/, "") || undefined;
  } catch {
    return undefined;
  }
}

main();

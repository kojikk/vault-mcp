import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync } from "node:fs";
import fs from "node:fs";
import git from "isomorphic-git";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VaultCore } from "../src/core/vault-core.js";
import { GraphIndex } from "../src/core/graph/assemble.js";
import { makeServerFactory } from "../src/mcp.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let vaultRoot: string;
let client: Client;
let core: VaultCore;

async function text(name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return res.content.map((c) => c.text).join("\n");
}

beforeEach(async () => {
  vaultRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "vault-it-")));
  core = new VaultCore({ vaultRoot, git: { name: "t", email: "t@t" }, logger: silent });
  await core.init();
  const graph = new GraphIndex(core);
  core.onMutation(() => graph.invalidate());
  const makeServer = makeServerFactory({ core, graph, log: silent });
  const server = makeServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe("read/write happy path", () => {
  it("creates a node and a note, then reads it wrapped as untrusted", async () => {
    expect(await text("create_node", { path: "Milestone-A", type: "milestone", summary: "life area" })).toContain("created node");
    await text("create_note", { path: "Milestone-A/idea.md", content: "купить молока" });
    const read = await text("read_file", { path: "Milestone-A/idea.md" });
    expect(read).toContain("UNTRUSTED_VAULT_CONTENT");
    expect(read).toContain("купить молока");
  });

  it("search finds content for dedup", async () => {
    await text("create_note", { path: "note.md", content: "уникальный_маркер_XYZ here" });
    const hits = await text("search", { query: "уникальный_маркер_XYZ" });
    expect(hits).toContain("note.md");
  });

  it("create_note refuses to overwrite", async () => {
    await text("create_note", { path: "dup.md", content: "one" });
    const second = await text("create_note", { path: "dup.md", content: "two" });
    expect(second).toContain("ALREADY_EXISTS");
    expect(readFileSync(path.join(vaultRoot, "dup.md"), "utf8")).toContain("one");
  });
});

describe("idempotency", () => {
  it("applies a replayed append at most once", async () => {
    await text("create_note", { path: "n/_home.md", content: "# n\n" });
    await text("append_to_home", { node: "n", text: "LINE", idempotency_key: "k1" });
    const replay = await text("append_to_home", { node: "n", text: "LINE", idempotency_key: "k1" });
    expect(replay).toContain("idempotent replay");
    const home = readFileSync(path.join(vaultRoot, "n", "_home.md"), "utf8");
    expect(home.match(/LINE/g)?.length).toBe(1);
  });
});

describe("move with backlink repair", () => {
  it("dry-run changes nothing, confirm moves and fixes links", async () => {
    await text("create_note", { path: "a.md", content: "see [[b]] for details" });
    await text("create_note", { path: "b.md", content: "the b note" });

    const plan = await text("move", { from: "b.md", to: "c.md" });
    expect(plan).toContain("DRY-RUN");
    expect(existsSync(path.join(vaultRoot, "b.md"))).toBe(true); // unchanged
    expect(existsSync(path.join(vaultRoot, "c.md"))).toBe(false);

    await text("move", { from: "b.md", to: "c.md", confirm: true });
    expect(existsSync(path.join(vaultRoot, "b.md"))).toBe(false);
    expect(existsSync(path.join(vaultRoot, "c.md"))).toBe(true);
    expect(readFileSync(path.join(vaultRoot, "a.md"), "utf8")).toContain("[[c]]");
  });
});

describe("move safety", () => {
  it("refuses to overwrite an existing destination", async () => {
    await text("create_note", { path: "src-ow.md", content: "SOURCE" });
    await text("create_note", { path: "dst-ow.md", content: "DEST" });
    const res = await text("move", { from: "src-ow.md", to: "dst-ow.md", confirm: true });
    expect(res).toContain("ALREADY_EXISTS");
    expect(readFileSync(path.join(vaultRoot, "src-ow.md"), "utf8")).toContain("SOURCE");
    expect(readFileSync(path.join(vaultRoot, "dst-ow.md"), "utf8")).toContain("DEST");
  });

  it("folder move stages deletions of the old paths (clean git status)", async () => {
    await text("create_node", { path: "Area" });
    await text("create_note", { path: "Area/n1.md", content: "one" });
    await text("create_note", { path: "Area/n2.md", content: "two" });
    await text("move", { from: "Area", to: "Zone", confirm: true });

    const matrix = await git.statusMatrix({ fs, dir: vaultRoot });
    // Old paths must be fully gone from HEAD, the index and the worktree…
    expect(matrix.filter(([f]) => f.startsWith("Area/"))).toEqual([]);
    // …and the new paths must be committed clean ([head, workdir, stage] = [1, 1, 1]).
    const moved = matrix.filter(([f]) => f.startsWith("Zone/"));
    expect(moved.length).toBeGreaterThanOrEqual(2);
    expect(moved.every(([, head, workdir, stage]) => head === 1 && workdir === 1 && stage === 1)).toBe(true);
  });

  it("folder soft_delete stages deletions of the old paths", async () => {
    await text("create_node", { path: "Doomed" });
    await text("create_note", { path: "Doomed/x.md", content: "x" });
    await text("soft_delete", { path: "Doomed", confirm: true });

    const matrix = await git.statusMatrix({ fs, dir: vaultRoot });
    expect(matrix.filter(([f]) => f.startsWith("Doomed/"))).toEqual([]);
    const trashed = matrix.filter(([f]) => f.startsWith(".trash/"));
    expect(trashed.length).toBeGreaterThanOrEqual(3); // _home, _memory, x.md
    expect(trashed.every(([, head, workdir, stage]) => head === 1 && workdir === 1 && stage === 1)).toBe(true);
  });
});

describe("transaction rollback", () => {
  it("a failing promote restores moved files and removes created scaffolding", async () => {
    await text("create_node", { path: "Proj2" });
    await text("create_note", { path: "Proj2/t1.md", content: "topic one" });

    // The second file does not exist: the transaction fails AFTER t1 was moved and the
    // child node scaffolding was written — everything must be rolled back.
    const res = await text("promote", {
      node: "Proj2",
      children: [{ name: "Sub", files: ["Proj2/t1.md", "Proj2/missing.md"] }],
      confirm: true,
    });
    expect(res).toContain("NOT_FOUND");

    expect(readFileSync(path.join(vaultRoot, "Proj2", "t1.md"), "utf8")).toContain("topic one");
    expect(existsSync(path.join(vaultRoot, "Proj2", "Sub"))).toBe(false);

    // No half-written state leaked into git either.
    const matrix = await git.statusMatrix({ fs, dir: vaultRoot });
    expect(matrix.filter(([f]) => f.startsWith("Proj2/Sub"))).toEqual([]);
  });

  it("a failed mutation leaves no phantom journal entry", async () => {
    await text("create_note", { path: "j.md", content: "x" });
    const logBefore = readFileSync(path.join(vaultRoot, "_log.md"), "utf8");
    await text("promote", {
      node: "Proj3",
      children: [{ name: "S", files: ["Proj3/nope.md"] }],
      confirm: true,
    });
    const logAfter = readFileSync(path.join(vaultRoot, "_log.md"), "utf8");
    expect(logAfter).toBe(logBefore);
  });
});

describe("soft_delete (no hard delete)", () => {
  it("moves into .trash and is restorable", async () => {
    await text("create_note", { path: "trash-me.md", content: "bye" });
    const plan = await text("soft_delete", { path: "trash-me.md" });
    expect(plan).toContain("DRY-RUN");
    expect(existsSync(path.join(vaultRoot, "trash-me.md"))).toBe(true);

    const applied = await text("soft_delete", { path: "trash-me.md", confirm: true });
    expect(applied).toContain(".trash");
    expect(existsSync(path.join(vaultRoot, "trash-me.md"))).toBe(false);
    // The content still exists somewhere under .trash.
    const trashDir = path.join(vaultRoot, ".trash");
    expect(existsSync(trashDir)).toBe(true);
  });
});

describe("promote transaction", () => {
  it("splits a project into child nodes with backlink repair", async () => {
    await text("create_node", { path: "Proj", type: "project" });
    await text("create_note", { path: "Proj/topic1.md", content: "t1" });
    await text("create_note", { path: "Proj/topic2.md", content: "t2" });
    await text("create_note", { path: "ref.md", content: "ref to [[topic1]]" });

    await text("promote", {
      node: "Proj",
      children: [{ name: "Sub", files: ["Proj/topic1.md"] }],
      confirm: true,
    });
    expect(existsSync(path.join(vaultRoot, "Proj", "Sub", "topic1.md"))).toBe(true);
    expect(existsSync(path.join(vaultRoot, "Proj", "Sub", "_home.md"))).toBe(true);
    // basename-based wikilink stays valid (basename unchanged), pointer index added.
    const home = readFileSync(path.join(vaultRoot, "Proj", "_home.md"), "utf8");
    expect(home).toContain("Подузлы");
  });
});

describe("add_raw (append-only sources)", () => {
  it("writes a timestamped .md into _raw/ with frontmatter", async () => {
    const res = await text("add_raw", { content: "сырой текст статьи", category: "articles", title: "Моя статья", source: "https://x" });
    const m = res.match(/_raw\/articles\/[^\s]+\.md/);
    expect(m).not.toBeNull();
    const body = readFileSync(path.join(vaultRoot, m![0]), "utf8");
    expect(body).toContain("ingested: false");
    expect(body).toContain("https://x");
    expect(body).toContain("сырой текст статьи");
  });

  it("is idempotent on replay", async () => {
    await text("add_raw", { content: "x", idempotency_key: "raw1" });
    const replay = await text("add_raw", { content: "x", idempotency_key: "raw1" });
    expect(replay).toContain("idempotent replay");
  });
});

describe("search scope", () => {
  it("knowledge scope excludes _raw", async () => {
    await text("add_raw", { content: "уникмаркер_рав", category: "notes" });
    await text("create_note", { path: "Знания/k.md", content: "уникмаркер_рав в знании" });
    const all = await text("search", { query: "уникмаркер_рав" });
    expect(all).toContain("_raw/");
    const knowledge = await text("search", { query: "уникмаркер_рав", scope: "knowledge" });
    expect(knowledge).toContain("Знания/k.md");
    expect(knowledge).not.toContain("_raw/");
  });
});

describe("lint", () => {
  it("reports orphans, broken links, stale entities, unlinked raw", async () => {
    await text("create_note", { path: "orphan.md", content: "никто на меня не ссылается" });
    await text("create_note", { path: "src.md", content: "ссылка на [[nonexistent-xyz]]" });
    await text("create_note", { path: "Знания/old.md", content: "старьё", frontmatter: { type: "entity", updated: "2000-01-01" } });
    await text("add_raw", { content: "несвязанное сырьё", category: "notes" });

    const res = await text("lint", {});
    const report = JSON.parse(res.slice(res.indexOf("{")));
    expect(report.orphans).toContain("orphan.md");
    expect(report.brokenLinks.some((b: { target: string }) => b.target === "nonexistent-xyz")).toBe(true);
    expect(report.staleEntities.some((s: { file: string }) => s.file === "Знания/old.md")).toBe(true);
    expect(report.unlinkedRaw.length).toBeGreaterThan(0);
  });
});

describe("edit_note (anchored, two-step)", () => {
  it("dry-run shows a diff and changes nothing; confirm applies", async () => {
    await text("create_note", { path: "e.md", content: "цена была 100 рублей" });
    const plan = await text("edit_note", { path: "e.md", old_string: "100", new_string: "200" });
    expect(plan).toContain("DRY-RUN");
    expect(readFileSync(path.join(vaultRoot, "e.md"), "utf8")).toContain("100"); // unchanged

    const applied = await text("edit_note", { path: "e.md", old_string: "100", new_string: "200", confirm: true });
    expect(applied).toContain("edited e.md");
    expect(readFileSync(path.join(vaultRoot, "e.md"), "utf8")).toContain("200 рублей");
  });

  it("refuses an ambiguous match unless expected_occurrences is set", async () => {
    await text("create_note", { path: "amb.md", content: "x x x" });
    const ambiguous = await text("edit_note", { path: "amb.md", old_string: "x", new_string: "y", confirm: true });
    expect(ambiguous).toContain("INVALID_NAME");
    expect(readFileSync(path.join(vaultRoot, "amb.md"), "utf8")).toContain("x x x"); // unchanged

    const ok = await text("edit_note", { path: "amb.md", old_string: "x", new_string: "y", expected_occurrences: 3, confirm: true });
    expect(ok).toContain("3 occurrence");
    expect(readFileSync(path.join(vaultRoot, "amb.md"), "utf8")).toContain("y y y");
  });

  it("refuses a missing old_string and refuses to edit _log.md", async () => {
    await text("create_note", { path: "m.md", content: "hello" });
    const missing = await text("edit_note", { path: "m.md", old_string: "NOPE", new_string: "x", confirm: true });
    expect(missing).toContain("NOT_FOUND");

    const logEdit = await text("edit_note", { path: "_log.md", old_string: "create_note", new_string: "x", confirm: true });
    expect(logEdit).toContain("RESERVED_PATH");
  });

  it("can refresh a cache file like _index.md", async () => {
    await text("update_index", { content: "# index\n- nodeA: старое\n" });
    await text("edit_note", { path: "_index.md", old_string: "старое", new_string: "новое", confirm: true });
    expect(readFileSync(path.join(vaultRoot, "_index.md"), "utf8")).toContain("новое");
  });

  it("is idempotent on replay", async () => {
    await text("create_note", { path: "idem.md", content: "AAA" });
    await text("edit_note", { path: "idem.md", old_string: "AAA", new_string: "BBB", confirm: true, idempotency_key: "ed1" });
    const replay = await text("edit_note", { path: "idem.md", old_string: "AAA", new_string: "BBB", confirm: true, idempotency_key: "ed1" });
    expect(replay).toContain("idempotent replay");
  });
});

describe("ingest primitives", () => {
  it("mark_raw_ingested flips only the flag and leaves the body", async () => {
    const res = await text("add_raw", { content: "тело сырья остаётся", category: "notes", title: "T" });
    const rawRel = res.match(/_raw\/notes\/[^\s]+\.md/)![0];
    expect(readFileSync(path.join(vaultRoot, rawRel), "utf8")).toContain("ingested: false");

    const marked = await text("mark_raw_ingested", { path: rawRel });
    expect(marked).toContain("ingested: true");
    const body = readFileSync(path.join(vaultRoot, rawRel), "utf8");
    expect(body).toContain("ingested: true");
    expect(body).toContain("тело сырья остаётся");
  });

  it("mark_raw_ingested flips the flag byte-precisely without reformatting frontmatter", async () => {
    const res = await text("add_raw", {
      content: "тело сырья",
      title: "Заголовок: с двоеточием",
      source: "https://example.com/a?b=1",
    });
    const rawRel = res.match(/_raw\/notes\/[^\s]+\.md/)![0];
    const before = readFileSync(path.join(vaultRoot, rawRel), "utf8");
    await text("mark_raw_ingested", { path: rawRel });
    const after = readFileSync(path.join(vaultRoot, rawRel), "utf8");
    // The ONLY difference is the flag line — quoting, dates and body are untouched.
    expect(after).toBe(before.replace("ingested: false", "ingested: true"));
  });

  it("mark_raw_ingested rejects paths outside _raw/", async () => {
    await text("create_note", { path: "notraw.md", content: "x" });
    const rejected = await text("mark_raw_ingested", { path: "notraw.md" });
    expect(rejected).toContain("INVALID_NAME");
  });

  it("append_contradiction creates the table and lint counts it open", async () => {
    await text("append_contradiction", {
      concept: "RAG",
      claim_a: "устарел",
      source_a: "статья X",
      claim_b: "нужен для больших баз",
      source_b: "статья Y",
    });
    const contra = readFileSync(path.join(vaultRoot, "_contradictions.md"), "utf8");
    expect(contra).toContain("| RAG |");
    expect(contra).toContain("| open |");

    const lint = await text("lint", {});
    const report = JSON.parse(lint.slice(lint.indexOf("{")));
    expect(report.openContradictions).toBeGreaterThan(0);
  });
});

describe("ingest_planner (read-only worksheet)", () => {
  it("recommends UPDATE for known concepts and CREATE for new ones, and writes nothing", async () => {
    await text("create_note", { path: "Знания/LangGraph.md", content: "LangGraph это фреймворк", frontmatter: { type: "entity" } });
    const raw = await text("add_raw", { content: "про LangGraph и про NeverHeardOf", category: "articles" });
    const rawRel = raw.match(/_raw\/articles\/[^\s]+\.md/)![0];

    const res = await text("ingest_planner", { concepts: ["LangGraph", "NeverHeardOf"], raw_path: rawRel });
    const data = JSON.parse(res.slice(res.indexOf("{")));
    const lg = data.worksheet.find((w: { concept: string }) => w.concept === "LangGraph");
    const nh = data.worksheet.find((w: { concept: string }) => w.concept === "NeverHeardOf");
    expect(lg.recommendation).toBe("UPDATE");
    expect(lg.topCandidate).toContain("Знания/LangGraph.md");
    expect(nh.recommendation).toBe("CREATE");
    expect(data.raw.exists).toBe(true);
    expect(data.raw.ingested).toBe(false);
    // raw was not marked ingested by the planner (read-only)
    expect(readFileSync(path.join(vaultRoot, rawRel), "utf8")).toContain("ingested: false");
  });
});

describe("journal + commit", () => {
  it("writes _log.md and commits each mutation", async () => {
    await text("create_note", { path: "x.md", content: "hi" });
    const log = readFileSync(path.join(vaultRoot, "_log.md"), "utf8");
    expect(log).toContain("create_note");
    expect(existsSync(path.join(vaultRoot, ".git"))).toBe(true);
  });
});

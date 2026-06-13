import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VaultCore } from "../src/core/vault-core.js";
import { GraphIndex, buildCodeGraph, parseCodeRef } from "../src/core/graph/assemble.js";
import { makeServerFactory } from "../src/mcp.js";
import { parseRefs } from "../src/core/graph/linkparse.js";
import { buildDerived } from "../src/core/graph/builder.js";
import { matchNodes, normalizeLabel, tokenize, splitIdentifier } from "../src/core/graph/match.js";
import { bfsSubgraph, shortestPath } from "../src/core/graph/traverse.js";
import { sanitize, renderSubgraph } from "../src/core/graph/render.js";
import { loadSemantic, EDGES_FILE, loadCodeNamespace, listCodeNamespaces, codeNsRel } from "../src/core/graph/store.js";
import { detectCommunities, godNodes } from "../src/core/graph/communities.js";
import { runLint } from "../src/core/lint.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let vaultRoot: string;
let core: VaultCore;
let graph: GraphIndex;
let client: Client;

function file(rel: string, content: string): void {
  const abs = path.join(vaultRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

async function text(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
  };
  return res.content.map((c) => c.text).join("\n");
}

beforeEach(async () => {
  vaultRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "vault-graph-")));
  core = new VaultCore({ vaultRoot, git: { name: "t", email: "t@t" }, logger: silent });
  await core.init();
  graph = new GraphIndex(core);
  core.onMutation(() => graph.invalidate());
  const server = makeServerFactory({ core, graph, log: silent })();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

// --------------------------- linkparse ---------------------------

describe("linkparse", () => {
  it("extracts wikilinks, embeds, aliases/headings stripped, md links, tags, frontmatter", () => {
    const refs = parseRefs(
      [
        "---",
        "type: entity",
        "aliases: [RAG, поиск с дополнением]",
        "tags: [ai]",
        "---",
        "Тело со ссылкой [[Эмбеддинги|алиас]] и [[Узел#секция]] и ![[схема.png]].",
        "Md-ссылка [тут](Знания/AI/LLM.md). Тег #ml/основы и не-тег #2026.",
      ].join("\n"),
    );
    expect(refs.entity).toBe(true);
    expect(refs.aliases).toEqual(["RAG", "поиск с дополнением"]);
    expect(refs.links).toEqual([
      { target: "Эмбеддинги", embed: false },
      { target: "Узел", embed: false },
      { target: "схема.png", embed: true },
      { target: "Знания/AI/LLM.md", embed: false },
    ]);
    expect(refs.tags).toContain("ai");
    expect(refs.tags).toContain("ml/основы");
    expect(refs.tags).not.toContain("2026");
  });

  it("survives malformed frontmatter", () => {
    const refs = parseRefs("---\n: broken yaml [\n---\nсм. [[Цель]]");
    expect(refs.links.map((l) => l.target)).toContain("Цель");
  });
});

// --------------------------- builder ---------------------------

describe("buildDerived", () => {
  it("builds note/org/tag nodes and resolves links; raw and service zones excluded", () => {
    file("Знания/AI/RAG.md", "---\ntype: entity\n---\nИспользует [[Эмбеддинги]] #ai");
    file("Знания/AI/Эмбеддинги.md", "---\ntype: entity\n---\nБаза.");
    file("Проект-X/_home.md", "Проект про [[RAG]].");
    file("Проект-X/_memory.md", "Память.");
    file("_raw/notes/x.md", "Сырьё с [[RAG]] — не должно попасть в граф.");
    file("_index.md", "[[RAG]] — манифест не участвует.");

    const d = buildDerived(core);
    expect(d.nodes.get("Знания/AI/RAG.md")?.entity).toBe(true);
    expect(d.nodes.get("Проект-X")?.kind).toBe("org");
    expect(d.nodes.get("tag:ai")?.kind).toBe("tag");

    const rels = d.edges.map((e) => `${e.src}→${e.tgt}`);
    expect(rels).toContain("Знания/AI/RAG.md→Знания/AI/Эмбеддинги.md");
    expect(rels).toContain("Проект-X→Знания/AI/RAG.md"); // resolved by unique basename
    expect(rels.filter((r) => r.startsWith("_raw")).length).toBe(0);
    expect(rels.filter((r) => r.startsWith("_index")).length).toBe(0);
  });

  it("does not guess ambiguous basenames", () => {
    file("A/Тема.md", "один");
    file("B/Тема.md", "два");
    file("C/линкер.md", "см. [[Тема]]");
    const d = buildDerived(core);
    expect(d.edges.filter((e) => e.src === "C/линкер.md").length).toBe(0);
  });
});

// --------------------------- match ---------------------------

describe("matchNodes", () => {
  it("normalizes ё/case/diacritics and ranks exact label above token overlap", () => {
    expect(normalizeLabel("Ёлка É")).toBe("елка e");
    expect(tokenize("Вишлист-оркестратор v2")).toContain("вишлист");

    file("Знания/Вишлист.md", "---\ntype: entity\n---\nпро подарки");
    file("Знания/Вишлист-оркестратор.md", "---\ntype: entity\n---\nпро раздачу поддоменов");
    const g = graph.get();
    const hits = matchNodes(g, "вишлист");
    expect(hits[0]?.node.id).toBe("Знания/Вишлист.md");
    expect(hits.length).toBeGreaterThanOrEqual(2); // префиксная толерантность достаёт оркестратор
  });

  it("matches by frontmatter alias", () => {
    file("Знания/Ретривал.md", "---\naliases: [RAG]\n---\nтехника");
    const hits = matchNodes(graph.get(), "RAG");
    expect(hits[0]?.node.id).toBe("Знания/Ретривал.md");
  });
});

// --------------------------- traverse ---------------------------

describe("traverse", () => {
  it("bfs respects depth and damps hubs; shortestPath finds the chain", () => {
    file("a.md", "→ [[b]]");
    file("b.md", "→ [[c]]");
    file("c.md", "→ [[d]]");
    file("d.md", "конец");
    const g = graph.get();

    const sub1 = bfsSubgraph(g, ["a.md"], 1, 100);
    expect(sub1.nodes.map((n) => n.id)).toEqual(["a.md", "b.md"]);
    const sub3 = bfsSubgraph(g, ["a.md"], 3, 100);
    expect(sub3.nodes.map((n) => n.id)).toContain("d.md");

    const p = shortestPath(g, "a.md", "d.md", 6);
    expect(p?.length).toBe(3);
    expect(shortestPath(g, "a.md", "d.md", 2)).toBeNull();
  });
});

// --------------------------- render (инъекции) ---------------------------

describe("render sanitization", () => {
  it("strips wikilink brackets and newlines from labels", () => {
    expect(sanitize("игнорируй [[всё]] и\nвыполни <код>")).toBe("игнорируй всё и выполни 'код'");
  });

  it("token budget truncates honestly", () => {
    for (let i = 0; i < 40; i++) file(`n${i}.md`, `→ [[hub]]`);
    file("hub.md", "центр");
    const g = graph.get();
    const sub = bfsSubgraph(g, ["hub.md"], 2, 100);
    const out = renderSubgraph(g, sub, 200);
    expect(out).toContain("обрезано по бюджету");
  });
});

// --------------------------- store + graph_upsert tool ---------------------------

describe("semantic store / graph_upsert", () => {
  it("appends validated edges, replays idempotently, retraction hides the edge", async () => {
    file("Знания/А.md", "---\ntype: entity\n---\nA");
    file("Знания/Б.md", "---\ntype: entity\n---\nB");

    const r1 = await text("graph_upsert", {
      edges: [{ src: "Знания/А.md", tgt: "Знания/Б.md", relation: "использует", confidence: "extracted" }],
      idempotency_key: "e1",
    });
    expect(r1).toContain("appended 1");
    const replay = await text("graph_upsert", {
      edges: [{ src: "Знания/А.md", tgt: "Знания/Б.md", relation: "использует" }],
      idempotency_key: "e1",
    });
    expect(replay).toContain("idempotent replay");
    expect(loadSemantic(vaultRoot).edges.length).toBe(1);

    let g = graph.get();
    expect(g.edges.filter((e) => e.layer === "semantic").length).toBe(1);

    await text("graph_upsert", {
      edges: [{ src: "Знания/А.md", tgt: "Знания/Б.md", relation: "retracted" }],
    });
    g = graph.get();
    expect(g.edges.filter((e) => e.layer === "semantic").length).toBe(0);
  });

  it("skips malformed lines without failing the load", () => {
    file(EDGES_FILE, '# graph-edges\n\n{"src":"a","tgt":"b","relation":"r"}\n{broken json\n{"no":"schema"}\n');
    const { edges, skipped } = loadSemantic(vaultRoot);
    expect(edges.length).toBe(1);
    expect(skipped).toBe(2);
  });

  it("reports unresolved endpoints as concept candidates", async () => {
    const r = await text("graph_upsert", {
      edges: [{ src: "Совершенно новый концепт", tgt: "Другой концепт", relation: "связан" }],
    });
    expect(r).toContain("Концепты без страниц");
  });
});

// --------------------------- query tools ---------------------------

describe("graph query tools", () => {
  beforeEach(() => {
    file("Знания/AI/RAG.md", "---\ntype: entity\n---\nИспользует [[Эмбеддинги]].");
    file("Знания/AI/Эмбеддинги.md", "---\ntype: entity\n---\nВекторы. #ai");
    file("Проекты/Бот/_home.md", "Бот применяет [[RAG]].");
  });

  it("graph_query returns the wrapped subgraph with pages to read", async () => {
    const out = await text("graph_query", { question: "что связано с RAG" });
    expect(out).toContain("UNTRUSTED_VAULT_CONTENT");
    expect(out).toContain("Знания/AI/RAG.md");
    expect(out).toContain("Эмбеддинги");
  });

  it("graph_query is honest about a miss", async () => {
    const out = await text("graph_query", { question: "квантовая хромодинамика" });
    expect(out).toContain("0 узлов");
  });

  it("graph_neighbors resolves a node by label and lists edges", async () => {
    const out = await text("graph_neighbors", { node: "RAG" });
    expect(out).toContain("Эмбеддинги");
  });

  it("graph_path connects org node to a page through links", async () => {
    const out = await text("graph_path", { source: "Проекты/Бот", target: "Эмбеддинги" });
    expect(out).toContain("RAG");
  });

  it("graph_stats reports layers and coverage; lint exposes graph section", async () => {
    await text("graph_upsert", {
      edges: [{ src: "Знания/AI/RAG.md", tgt: "Знания/AI/Эмбеддинги.md", relation: "использует" }],
    });
    const stats = await text("graph_stats");
    expect(stats).toMatch(/semantic 1/);
    expect(stats).toMatch(/Entity-страницы: 2, покрыто semantic-рёбрами: 2/);

    const lint = await text("lint");
    expect(lint).toContain("entityCoverage: 100%");
  });

  it("read_hot carries the graph digest", async () => {
    const out = await text("read_hot");
    expect(out).toContain("ГРАФ:");
    expect(out).toContain("graph_query");
  });
});

// --------------------------- graph_export ---------------------------

describe("graph_export", () => {
  it("dumps nodes with degree/community/mtime and edges with layer/created", async () => {
    file("Знания/AI/RAG.md", "---\ntype: entity\n---\nИспользует [[Эмбеддинги]].");
    file("Знания/AI/Эмбеддинги.md", "---\ntype: entity\n---\nВекторы.");
    await text("graph_upsert", {
      edges: [{ src: "Знания/AI/RAG.md", tgt: "Знания/AI/Эмбеддинги.md", relation: "использует" }],
    });

    const out = JSON.parse(await text("graph_export"));
    expect(out.stats.nodes).toBeGreaterThanOrEqual(2);
    const rag = out.nodes.find((n: { id: string }) => n.id === "Знания/AI/RAG.md");
    expect(rag.entity).toBe(true);
    expect(rag.degree).toBeGreaterThanOrEqual(2); // derived link + semantic edge
    expect(rag.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rag.community).not.toBeNull();

    const sem = out.edges.find((e: { layer: string }) => e.layer === "semantic");
    expect(sem.relation).toBe("использует");
    expect(sem.created).toMatch(/^\d{4}-\d{2}-\d{2}/); // graph_upsert stamps the date
  });
});

// --------------------------- communities ---------------------------

describe("communities", () => {
  it("detects clusters and god nodes on a two-cluster graph", () => {
    // Barbell: two triangles joined by a single bridge a3→b1.
    file("a1.md", "→ [[a2]] [[a3]]");
    file("a2.md", "→ [[a3]]");
    file("a3.md", "мост → [[b1]]");
    file("b1.md", "→ [[b2]] [[b3]]");
    file("b2.md", "→ [[b3]]");
    file("b3.md", "конец");
    const g = graph.get();
    const report = detectCommunities(g);
    expect(report.count).toBeGreaterThanOrEqual(2);
    expect(report.bridges.length).toBeGreaterThanOrEqual(1);
    expect(godNodes(g, 3).length).toBe(3);
  });
});

// --------------------------- cache invalidation ---------------------------

describe("graph cache", () => {
  it("invalidates on a mutation through the core", async () => {
    file("один.md", "первый");
    expect(graph.get().nodes.has("один.md")).toBe(true);
    await text("create_note", { path: "второй.md", content: "см. [[один]]" });
    expect(graph.get().nodes.has("второй.md")).toBe(true); // без инвалидации жил бы кэш 60с
  });
});

// --------------------------- lint: broken endpoints ---------------------------

describe("lint graph section", () => {
  it("flags semantic edges recorded against missing pages", async () => {
    file("Знания/Живая.md", "---\ntype: entity\n---\nстраница");
    await text("graph_upsert", {
      edges: [{ src: "Знания/Живая.md", tgt: "Знания/Удалённая.md", relation: "ссылается" }],
    });
    const lintOut = await text("lint");
    const parsed = JSON.parse(lintOut.slice(lintOut.indexOf("{")));
    expect(parsed.graph.brokenEdgeEndpoints).toContain("Знания/Удалённая.md");
  });
});

// --------------------------- code namespaces (GRAPH-PLAN-CODE.md) ---------------------------

/** A small fixture code snapshot: a module with two functions that call each other. */
const FIXTURE_NS = [
  '{"t":"meta","project":"fixture","commit":"abc1234","scanned":"2026-06-13","generator":"test"}',
  '{"t":"node","id":"src/match.ts","kind":"module","file":"src/match.ts"}',
  '{"t":"node","id":"src/match.ts#scoreQuery","kind":"function","file":"src/match.ts","line":42,"sig":"scoreQuery(q: string)"}',
  '{"t":"node","id":"src/match.ts#tokenize","kind":"function","file":"src/match.ts","line":10}',
  '{"t":"node","id":"src/build.ts","kind":"module","file":"src/build.ts"}',
  '{"t":"edge","src":"src/match.ts","tgt":"src/match.ts#scoreQuery","rel":"defines","conf":"extracted"}',
  '{"t":"edge","src":"src/match.ts","tgt":"src/match.ts#tokenize","rel":"defines","conf":"extracted"}',
  '{"t":"edge","src":"src/match.ts#scoreQuery","tgt":"src/match.ts#tokenize","rel":"calls","conf":"extracted"}',
  '{"t":"edge","src":"src/build.ts","tgt":"src/match.ts","rel":"imports","conf":"extracted"}',
  "{broken json line",
  "",
].join("\n") + "\n";

describe("code namespace store", () => {
  it("loads nodes/edges/meta and skips malformed lines", () => {
    file(codeNsRel("fixture"), FIXTURE_NS);
    const load = loadCodeNamespace(vaultRoot, "fixture");
    expect(load).not.toBeNull();
    expect(load!.project).toBe("fixture");
    expect(load!.commit).toBe("abc1234");
    expect(load!.nodes).toBe(4);
    expect(load!.edges).toBe(4);
    expect(load!.skipped).toBe(1); // the one broken json line
  });

  it("returns null for a missing project and rejects invalid project names", () => {
    expect(loadCodeNamespace(vaultRoot, "nope")).toBeNull();
    expect(() => codeNsRel("../escape")).toThrow();
    expect(() => codeNsRel("Bad Name")).toThrow();
  });

  it("listCodeNamespaces summarizes each snapshot without building a graph", () => {
    file(codeNsRel("fixture"), FIXTURE_NS);
    const list = listCodeNamespaces(vaultRoot);
    expect(list.map((c) => c.project)).toContain("fixture");
    const f = list.find((c) => c.project === "fixture")!;
    expect(f.nodes).toBe(4);
  });
});

describe("code namespace assembly + match", () => {
  it("splitIdentifier breaks camelCase / snake_case / paths", () => {
    expect(splitIdentifier("scoreQuery")).toEqual(["score", "query"]);
    expect(splitIdentifier("build_derived")).toContain("derived");
    expect(splitIdentifier("src/core/match.ts#scoreQuery")).toEqual(
      expect.arrayContaining(["src", "core", "match", "score", "query"]),
    );
  });

  it("buildCodeGraph assembles an isolated graph; code match finds a symbol by sub-word", () => {
    const load = loadCodeNamespace(vaultRoot, "fixture") ?? (() => {
      file(codeNsRel("fixture"), FIXTURE_NS);
      return loadCodeNamespace(vaultRoot, "fixture")!;
    })();
    const g = buildCodeGraph(load);
    expect(g.nodes.get("src/match.ts#scoreQuery")?.kind).toBe("code");
    // "score query" must reach scoreQuery via identifier splitting (code mode only).
    const hit = matchNodes(g, "score query", 3, { code: true })[0];
    expect(hit?.node.id).toBe("src/match.ts#scoreQuery");
  });

  it("does NOT leak code identifiers into kb matching", () => {
    file(codeNsRel("fixture"), FIXTURE_NS);
    file("Знания/Заметка.md", "обычная заметка");
    const kb = graph.get();
    // scoreQuery is a code symbol — the kb graph must not know it at all.
    expect(kb.nodes.has("src/match.ts#scoreQuery")).toBe(false);
    expect(matchNodes(kb, "scoreQuery").length).toBe(0);
  });
});

describe("ns routing in tools", () => {
  beforeEach(() => file(codeNsRel("fixture"), FIXTURE_NS));

  it("graph_query routes to a code namespace and points at the file", async () => {
    const out = await text("graph_query", { question: "scoreQuery", ns: "code:fixture" });
    expect(out).toContain("src/match.ts");
    expect(out).toContain("function");
  });

  it("graph_query errors clearly on an unknown ns and a missing project", async () => {
    expect(await text("graph_query", { question: "x", ns: "garbage" })).toContain("неизвестный ns");
    expect(await text("graph_query", { question: "x", ns: "code:absent" })).toContain("нет код-графа");
  });

  it("graph_neighbors and graph_path work inside a code namespace", async () => {
    const nb = await text("graph_neighbors", { node: "src/match.ts#scoreQuery", ns: "code:fixture" });
    expect(nb).toContain("tokenize");
    const pth = await text("graph_path", { source: "src/build.ts", target: "src/match.ts#tokenize", ns: "code:fixture" });
    expect(pth).toContain("tokenize");
  });

  it("graph_stats lists code namespaces separately from kb totals", async () => {
    const out = await text("graph_stats");
    expect(out).toContain("code:fixture");
    expect(out).toMatch(/4 узлов/);
  });

  it("getCode reloads when the snapshot file changes (mtime)", async () => {
    const first = graph.getCode("fixture");
    expect(first!.graph.nodes.has("src/build.ts")).toBe(true);
    // Overwrite with a different snapshot and bump mtime into the future.
    const abs = path.join(vaultRoot, codeNsRel("fixture"));
    const smaller =
      '{"t":"meta","project":"fixture","scanned":"2026-06-14"}\n{"t":"node","id":"src/only.ts","kind":"module","file":"src/only.ts"}\n';
    writeFileSync(abs, smaller, "utf8");
    const future = new Date(Date.now() + 5000);
    utimesSync(abs, future, future);
    const second = graph.getCode("fixture");
    expect(second!.graph.nodes.has("src/only.ts")).toBe(true);
    expect(second!.graph.nodes.has("src/build.ts")).toBe(false);
  });
});

describe("knowledge↔code bridges", () => {
  beforeEach(() => file(codeNsRel("fixture"), FIXTURE_NS));

  it("graph_upsert records a bridge; kb graph_query shows a code stub, not code nodes", async () => {
    file("Проекты/Сервис.md", "---\ntype: entity\n---\nоплата");
    const up = await text("graph_upsert", {
      edges: [{ src: "Проекты/Сервис.md", tgt: "code:fixture/src/match.ts#scoreQuery", relation: "реализовано в" }],
    });
    expect(up).toContain("appended 1");

    const out = await text("graph_query", { question: "Сервис" });
    expect(out).toContain("Мосты в код:");
    expect(out).toContain("код-граф fixture");
    // The actual code node must NOT be expanded into the kb result.
    expect(out).not.toContain("src/match.ts#tokenize");
  });

  it("rejects code↔code bridges and malformed code refs", async () => {
    const both = await text("graph_upsert", {
      edges: [{ src: "code:fixture/src/a.ts#x", tgt: "code:fixture/src/b.ts#y", relation: "calls" }],
    });
    expect(both).toContain("code↔code запрещено");
    const bad = await text("graph_upsert", {
      edges: [{ src: "Проекты/Сервис.md", tgt: "code:BadProject/x", relation: "r" }],
    });
    expect(bad).toContain("Некорректный код-мост");
  });

  it("parseCodeRef extracts project and node id", () => {
    expect(parseCodeRef("code:fixture/src/match.ts#scoreQuery")).toEqual({
      project: "fixture",
      nodeId: "src/match.ts#scoreQuery",
      codeId: "code:fixture/src/match.ts#scoreQuery",
    });
    expect(parseCodeRef("Знания/RAG.md")).toBeNull();
  });

  it("lint flags a bridge whose target is missing from the snapshot", async () => {
    file("Проекты/Сервис.md", "---\ntype: entity\n---\nx");
    await text("graph_upsert", {
      edges: [{ src: "Проекты/Сервис.md", tgt: "code:fixture/src/match.ts#renamedAway", relation: "реализовано в" }],
    });
    const lintOut = await text("lint");
    const parsed = JSON.parse(lintOut.slice(lintOut.indexOf("{")));
    expect(parsed.graph.staleBridges.join(" ")).toContain("renamedAway");
  });
});

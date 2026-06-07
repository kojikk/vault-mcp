import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VaultCore } from "../src/core/vault-core.js";
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
  const makeServer = makeServerFactory({ core, log: silent });
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

describe("journal + commit", () => {
  it("writes _log.md and commits each mutation", async () => {
    await text("create_note", { path: "x.md", content: "hi" });
    const log = readFileSync(path.join(vaultRoot, "_log.md"), "utf8");
    expect(log).toContain("create_note");
    expect(existsSync(path.join(vaultRoot, ".git"))).toBe(true);
  });
});

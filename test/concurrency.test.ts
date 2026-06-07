import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VaultCore } from "../src/core/vault-core.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let vaultRoot: string;
let core: VaultCore;

beforeEach(async () => {
  vaultRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "conc-")));
  core = new VaultCore({ vaultRoot, git: { name: "t", email: "t@t" }, logger: silent });
  await core.init();
});
afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe("concurrency (Phase 4)", () => {
  it("serializes concurrent appends with no lost updates", async () => {
    // Seed the file.
    await core.mutate({
      op: "seed",
      message: "seed",
      journal: {},
      body: async (tx) => tx.writeFile("counter.md", "start\n"),
    });

    const N = 25;
    const ops = Array.from({ length: N }, (_, i) =>
      core.mutate({
        op: "append",
        message: `append ${i}`,
        journal: {},
        body: async (tx) => {
          const prior = tx.read("counter.md");
          tx.writeFile("counter.md", prior + `line ${i}\n`);
        },
      }),
    );
    await Promise.all(ops);

    const lines = readFileSync(path.join(vaultRoot, "counter.md"), "utf8").trim().split("\n");
    // start + N lines, none lost (read-modify-write was atomic under the lock).
    expect(lines.length).toBe(N + 1);
    for (let i = 0; i < N; i++) {
      expect(lines).toContain(`line ${i}`);
    }
  });

  it("a failing mutation rolls back without poisoning the queue", async () => {
    await core.mutate({ op: "seed", message: "seed", journal: {}, body: async (tx) => tx.writeFile("a.md", "v1\n") });

    // This mutation throws after a write — the write must be rolled back to HEAD.
    await expect(
      core.mutate({
        op: "boom",
        message: "boom",
        journal: {},
        body: async (tx) => {
          tx.writeFile("a.md", "v2-uncommitted\n");
          throw new Error("simulated failure");
        },
      }),
    ).rejects.toThrow("simulated failure");

    // The next op still works, and a.md is back to v1.
    await core.mutate({ op: "ok", message: "ok", journal: {}, body: async (tx) => tx.writeFile("b.md", "ok\n") });
    expect(readFileSync(path.join(vaultRoot, "a.md"), "utf8")).toBe("v1\n");
    expect(readFileSync(path.join(vaultRoot, "b.md"), "utf8")).toBe("ok\n");
  });
});

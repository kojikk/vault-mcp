import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, ConfigError } from "../src/config.js";

let vaultRoot: string;
const GOOD_TOKEN = "f".repeat(40);

beforeEach(() => {
  vaultRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "cfg-")));
});
afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

function env(over: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { VAULT_ROOT: vaultRoot, MCP_TOKEN: GOOD_TOKEN, ...over } as NodeJS.ProcessEnv;
}

describe("fail-closed config (M-1/M-2)", () => {
  it("loads with a valid vault root and token", () => {
    const c = loadConfig(env({}));
    expect(c.vaultRoot).toBe(vaultRoot);
    expect(c.bindHost).toBe("127.0.0.1");
  });

  it("refuses to start without VAULT_ROOT (M-2)", () => {
    expect(() => loadConfig(env({ VAULT_ROOT: undefined }))).toThrow(ConfigError);
  });

  it("refuses a VAULT_ROOT that does not exist", () => {
    expect(() => loadConfig(env({ VAULT_ROOT: path.join(vaultRoot, "nope") }))).toThrow(ConfigError);
  });

  it("refuses a VAULT_ROOT that is a file, not a directory", () => {
    const f = path.join(vaultRoot, "afile.md");
    writeFileSync(f, "x");
    expect(() => loadConfig(env({ VAULT_ROOT: f }))).toThrow(/directory/);
  });

  it("refuses a missing token", () => {
    expect(() => loadConfig(env({ MCP_TOKEN: undefined }))).toThrow(/MCP_TOKEN/);
  });

  it("refuses a short token", () => {
    expect(() => loadConfig(env({ MCP_TOKEN: "tooshort" }))).toThrow(/too short/);
  });

  it("reads the token from MCP_TOKEN_FILE (Docker secret, C-3)", () => {
    const f = path.join(vaultRoot, "secret");
    writeFileSync(f, GOOD_TOKEN + "\n");
    const c = loadConfig(env({ MCP_TOKEN: undefined, MCP_TOKEN_FILE: f }));
    expect(c.token).toBe(GOOD_TOKEN);
  });

  it("rejects a non-integer PORT with a clear error (M-1)", () => {
    expect(() => loadConfig(env({ PORT: "abc" }))).toThrow(/PORT/);
  });

  it("normalizes boolean-like env without throwing (L-2)", () => {
    expect(() => loadConfig(env({ LOG_PRETTY: "yes" }))).not.toThrow();
    expect(() => loadConfig(env({ LOG_PRETTY: "0" }))).not.toThrow();
    expect(() => loadConfig(env({ LOG_PRETTY: "maybe" }))).toThrow();
  });
});

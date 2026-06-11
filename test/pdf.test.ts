import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
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

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
  };
  return res.content.map((c) => c.text).join("\n");
}

/** Build a minimal single-page PDF with a real text layer and a correct xref table. */
function minimalPdf(textLine: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, // content stream, built below
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 24 Tf 72 720 Td (${textLine}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefPos = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

beforeEach(async () => {
  vaultRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "vault-pdf-")));
  const core = new VaultCore({ vaultRoot, git: { name: "t", email: "t@t" }, logger: silent });
  await core.init();
  const graph = new GraphIndex(core);
  core.onMutation(() => graph.invalidate());
  const server = makeServerFactory({ core, graph, log: silent })();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);

  mkdirSync(path.join(vaultRoot, "_attachments"), { recursive: true });
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe("extract_pdf", () => {
  it("extracts the text layer of a PDF in _attachments/", async () => {
    writeFileSync(path.join(vaultRoot, "_attachments", "doc.pdf"), minimalPdf("Hello Vault Graph"));
    const out = await call("extract_pdf", { path: "_attachments/doc.pdf" });
    expect(out).toContain("UNTRUSTED_VAULT_CONTENT");
    expect(out).toContain("Hello Vault Graph");
    expect(out).toContain("1 стр.");
  });

  it("refuses paths outside _attachments/", async () => {
    const out = await call("extract_pdf", { path: "note.pdf" });
    expect(out).toContain("RESERVED_PATH");
  });

  it("reports a corrupt file honestly instead of erroring", async () => {
    writeFileSync(path.join(vaultRoot, "_attachments", "bad.pdf"), "это не pdf");
    const out = await call("extract_pdf", { path: "_attachments/bad.pdf" });
    expect(out).toContain("Не удалось разобрать PDF");
  });

  it("save_raw archives the text to _raw/docs/ with a source link", async () => {
    writeFileSync(path.join(vaultRoot, "_attachments", "src.pdf"), minimalPdf("Archived text"));
    const out = await call("extract_pdf", { path: "_attachments/src.pdf", save_raw: true, idempotency_key: "p1" });
    expect(out).toContain("_raw/docs/");
    const dir = path.join(vaultRoot, "_raw", "docs");
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).length).toBe(1);

    const replay = await call("extract_pdf", { path: "_attachments/src.pdf", save_raw: true, idempotency_key: "p1" });
    expect(replay).toContain("idempotent replay");
    expect(readdirSync(dir).length).toBe(1);
  });
});

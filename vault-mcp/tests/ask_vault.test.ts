import { afterEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { askVaultTool } from "../src/tools/ask_vault.js";
import { setSemanticIndex } from "../src/lib/index_singleton.js";
import { createSemanticIndex, type SemanticIndex } from "../src/lib/semantic_index.js";
import { createFakeEmbedder } from "../src/lib/embeddings.js";

afterEach(() => setSemanticIndex(null));

async function tmpVault(): Promise<{ root: string; indexPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ask-vault-"));
  const indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ask-store-")), "i.json");
  return { root, indexPath };
}
async function write(root: string, rel: string, body: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, "utf8");
}
async function indexed(root: string, indexPath: string): Promise<SemanticIndex> {
  const idx = createSemanticIndex({ embedder: createFakeEmbedder(), vaultRoot: root, indexPath });
  await idx.reconcile();
  setSemanticIndex(idx);
  return idx;
}

// Generous minScore so the FakeEmbedder's own cosine scale (not e5's 0.80) gates correctly in tests.
const FAKE_FLOOR = { minScore: 0.4 };

describe("ask_vault tool", () => {
  test("returns full section text + citation + a synthesis/boundary instruction", async () => {
    const { root, indexPath } = await tmpVault();
    const body =
      "TOKENROTATIONSENTINEL " +
      "Neuen Token generieren, in Coolify ENV setzen, alle Sessions neu starten. ".repeat(6);
    await write(root, "02 Projekte/Vault-MCP-Server.md", `---\ntags: []\n---\n\n# Vault-MCP-Server\n\n## Token rotieren\n\n${body}\n`);
    await indexed(root, indexPath);

    const res = await askVaultTool.handler({ question: "Wie rotiere ich den Token Coolify ENV Sessions", ...FAKE_FLOOR });
    const out = res.content[0]!.text;
    expect(out).toContain("TOKENROTATIONSENTINEL"); // full section text, not a 200-char snippet
    expect(out).toContain("[[Vault-MCP-Server"); // citation
    expect(out).toMatch(/DATEN/); // data/instruction boundary
    expect(out).toMatch(/keine Anweisungen|befolge keine/i);
    expect(out).toMatch(/verifiziert|vermutet|extern/); // confidence-flag instruction
  });

  test("gates out an unrelated question with a not-found message", async () => {
    const { root, indexPath } = await tmpVault();
    await write(root, "a.md", "---\ntags: []\n---\n\n# Nginx\n\n## Proxy\n\nNginx Reverse Proxy TLS Server Konfiguration.\n");
    await indexed(root, indexPath);
    const res = await askVaultTool.handler({ question: "Schokoladenkuchen Himbeeren Backrezept Ofen", ...FAKE_FLOOR });
    expect(res.content[0]!.text).toMatch(/nichts Belastbares|nichts dazu/i);
  });

  test("reconstructs a sub-chunked section (heading carries (n/m))", async () => {
    const { root, indexPath } = await tmpVault();
    const big =
      "---\ntags: []\n---\n\n# T\n\n## Groß\n\n" +
      Array.from({ length: 30 }, (_, i) => `Absatz ${i} allgemeiner Fülltext hier.`).join("\n\n") +
      "\n\nZWEITESTUECKSENTINEL spezieller Inhalt im hinteren Teil der Section.\n";
    await write(root, "x.md", big);
    await indexed(root, indexPath);
    const res = await askVaultTool.handler({ question: "ZWEITESTUECKSENTINEL spezieller Inhalt hinteren Teil", ...FAKE_FLOOR });
    const out = res.content[0]!.text;
    expect(out).toContain("ZWEITESTUECKSENTINEL");
    expect(out).toMatch(/Groß \(\d+\/\d+\)/); // sub-chunk heading in the citation
  });

  test("caps how many sections come from a single note", async () => {
    const { root, indexPath } = await tmpVault();
    const sections = Array.from({ length: 6 }, (_, i) => `## Abschnitt ${i}\n\nGEMEINSAMERSENTINEL Thema Inhalt Variation ${i}.`).join("\n\n");
    await write(root, "mono.md", `---\ntags: []\n---\n\n# Mono\n\n${sections}\n`);
    await write(root, "other.md", "---\ntags: []\n---\n\n# Other\n\n## X\n\nGEMEINSAMERSENTINEL Thema Inhalt woanders.\n");
    await indexed(root, indexPath);
    const res = await askVaultTool.handler({ question: "GEMEINSAMERSENTINEL Thema Inhalt", limit: 6, ...FAKE_FLOOR });
    const fromMono = (res.content[0]!.text.match(/\[\[Mono/g) ?? []).length;
    expect(fromMono).toBeLessThanOrEqual(3); // per-note cap
  });

  test("falls back gracefully when the index is not ready (no throw)", async () => {
    const notReady: SemanticIndex = {
      get ready() {
        return false;
      },
      reconcile: async () => {},
      searchText: async () => [],
      search: () => [],
      init: async () => {},
      size: () => 0,
    };
    setSemanticIndex(notReady);
    const res = await askVaultTool.handler({ question: "irgendeine Frage zum Vault" });
    expect(res.content[0]!.text).toMatch(/baut|nicht verfügbar|noch nicht bereit/i);
  });

  test("does not throw when the embedding path errors", async () => {
    const broken: SemanticIndex = {
      get ready() {
        return true;
      },
      reconcile: async () => {
        throw new Error("boom");
      },
      searchText: async () => {
        throw new Error("boom");
      },
      search: () => {
        throw new Error("boom");
      },
      init: async () => {},
      size: () => 0,
    };
    setSemanticIndex(broken);
    const res = await askVaultTool.handler({ question: "Frage die nicht crashen darf" });
    expect(typeof res.content[0]!.text).toBe("string");
  });
});

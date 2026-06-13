import { afterEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dedupWarning } from "../src/lib/dedup.js";
import { setSemanticIndex } from "../src/lib/index_singleton.js";
import { createSemanticIndex } from "../src/lib/semantic_index.js";
import { createFakeEmbedder } from "../src/lib/embeddings.js";
import { addToProjectTool } from "../src/tools/add_to_project.js";
import { vaultPath } from "../src/lib/vault.js";

afterEach(() => setSemanticIndex(null));

const CONTENT = "Token-Rotation Workflow Coolify ENV Redeploy Client Sessions neu starten";

async function indexWith(rel: string): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dedup-vault-"));
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `---\ntags: []\n---\n\n# Note\n\n## Eintrag\n\n${CONTENT}\n`, "utf8");
  const indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "dedup-store-")), "i.json");
  const idx = createSemanticIndex({ embedder: createFakeEmbedder(), vaultRoot: root, indexPath });
  await idx.reconcile();
  setSemanticIndex(idx);
}

describe("dedupWarning", () => {
  test("warns when a very similar section exists in another note", async () => {
    await indexWith("02 Projekte/Vault-MCP-Server.md");
    const warn = await dedupWarning(CONTENT, "02 Projekte/Andere Notiz.md");
    expect(warn).toContain("⚠");
    expect(warn).toContain("[[Vault-MCP-Server]]");
    expect(warn).toContain("Eintrag");
  });

  test("stays silent when the only match is the target note itself", async () => {
    await indexWith("02 Projekte/Vault-MCP-Server.md");
    const warn = await dedupWarning(CONTENT, "02 Projekte/Vault-MCP-Server.md");
    expect(warn).toBe("");
  });

  test("ignores matches in 06 Archiv/ and 01 Inbox/", async () => {
    await indexWith("06 Archiv/Alt.md");
    expect(await dedupWarning(CONTENT, "02 Projekte/X.md")).toBe("");
    await indexWith("01 Inbox/2026-06-13 1200 Idee.md");
    expect(await dedupWarning(CONTENT, "02 Projekte/X.md")).toBe("");
  });

  test("stays silent when nothing similar exists (below threshold)", async () => {
    await indexWith("02 Projekte/Vault-MCP-Server.md");
    const warn = await dedupWarning("völlig unverwandtes Thema über Gartenzwerge", "02 Projekte/X.md");
    expect(warn).toBe("");
  });

  test("stays silent when no index is configured", async () => {
    setSemanticIndex(null);
    expect(await dedupWarning(CONTENT, "02 Projekte/X.md")).toBe("");
  });

  test("add_to_project surfaces the dedup warning end-to-end", async () => {
    const root = vaultPath();
    const marker = "ZxqvDedupWire";
    const text = `${marker} ${marker} spezielle Singleton Reconcile Architektur Entscheidung`;
    const seedAbs = path.join(root, "02 Projekte", `Seed ${marker}.md`);
    const targetAbs = path.join(root, "02 Projekte", `Other ${marker}.md`);
    await fs.mkdir(path.dirname(seedAbs), { recursive: true });
    await fs.writeFile(seedAbs, `---\ntags: []\n---\n\n# Seed ${marker}\n\n## Eintrag\n\n${text}\n`, "utf8");
    try {
      const indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wire-store-")), "i.json");
      const idx = createSemanticIndex({ embedder: createFakeEmbedder(), vaultRoot: root, indexPath });
      await idx.reconcile();
      setSemanticIndex(idx);
      const res = await addToProjectTool.handler({ project: `Other ${marker}`, section: "Notizen", text });
      expect(res.content[0]!.text).toContain("⚠");
      expect(res.content[0]!.text).toContain(`Seed ${marker}`);
    } finally {
      await fs.rm(seedAbs, { force: true });
      await fs.rm(targetAbs, { force: true });
    }
  });
});

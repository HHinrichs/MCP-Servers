import { afterEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSimilarTool } from "../src/tools/find_similar.js";
import { setSemanticIndex } from "../src/lib/index_singleton.js";
import { createSemanticIndex, type SemanticIndex } from "../src/lib/semantic_index.js";
import { createFakeEmbedder } from "../src/lib/embeddings.js";

afterEach(() => setSemanticIndex(null));

async function tmpVaultWithNotes(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-vault-"));
  await fs.mkdir(path.join(root, "04 Ressourcen", "Nginx"), { recursive: true });
  await fs.writeFile(
    path.join(root, "04 Ressourcen", "Nginx", "Nginx.md"),
    "---\ntags: []\n---\n\n# Nginx\n\n## Reverse Proxy\n\nNginx terminiert TLS und leitet weiter.\n",
    "utf8",
  );
  return root;
}

describe("find_similar tool", () => {
  test("uses the embedding index and renders labels when ready", async () => {
    const root = await tmpVaultWithNotes();
    const indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "fs-store-")), "i.json");
    const idx = createSemanticIndex({ embedder: createFakeEmbedder(), vaultRoot: root, indexPath });
    await idx.reconcile();
    setSemanticIndex(idx);

    const res = await findSimilarTool.handler({ text: "Reverse Proxy TLS weiterleiten" });
    const out = res.content[0]!.text;
    expect(out).toContain("04 Ressourcen/Nginx/Nginx.md");
    expect(out).toContain("Reverse Proxy");
    expect(out).toMatch(/sehr ähnlich|verwandt|eher anders/);
    expect(out).not.toContain("0.15");
  });

  test("falls back to TF-IDF when no index is configured (no throw)", async () => {
    setSemanticIndex(null);
    const res = await findSimilarTool.handler({ text: "irgendein Suchtext zum Testen" });
    expect(Array.isArray(res.content)).toBe(true);
    expect(typeof res.content[0]!.text).toBe("string");
  });

  test("falls back to TF-IDF when the embedding path throws", async () => {
    const broken: SemanticIndex = {
      get ready() {
        return true;
      },
      reconcile: async () => {
        throw new Error("model exploded");
      },
      searchText: async () => {
        throw new Error("model exploded");
      },
      search: () => {
        throw new Error("model exploded");
      },
      init: async () => {},
      size: () => 0,
    };
    setSemanticIndex(broken);
    const res = await findSimilarTool.handler({ text: "Suchtext der nicht crashen darf" });
    expect(typeof res.content[0]!.text).toBe("string"); // returned, did not throw
  });
});

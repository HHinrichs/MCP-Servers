import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeEmbedder, type Embedder } from "../src/lib/embeddings.js";
import { createSemanticIndex, SIM, label } from "../src/lib/semantic_index.js";

/** FakeEmbedder wrapper that counts how many passage texts were embedded. */
function countingEmbedder(id?: string): Embedder & { passagesEmbedded: number } {
  const base = createFakeEmbedder();
  const wrap = {
    passagesEmbedded: 0,
    dim: base.dim,
    id: id ?? base.id,
    embedPassages: async (texts: string[]) => {
      wrap.passagesEmbedded += texts.length;
      return base.embedPassages(texts);
    },
    embedQuery: (t: string) => base.embedQuery(t),
  };
  return wrap;
}

async function tmpVault(): Promise<{ root: string; indexPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "semidx-vault-"));
  // index lives OUTSIDE the vault root (sibling)
  const indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "semidx-store-")), "index.json");
  return { root, indexPath };
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, "utf8");
}

const NGINX = "---\ntags: []\n---\n\n# Nginx\n\n## Setup\n\nReverse Proxy TLS Zertifikat Server.\n";
const HYDRO = "---\ntags: []\n---\n\n# Hydroponik\n\n## Nährlösung\n\npH Wert EC Dünger Pflanze.\n";

describe("semantic index", () => {
  test("reconcile + searchText ranks the more similar section first", async () => {
    const { root, indexPath } = await tmpVault();
    await write(root, "04 Ressourcen/Nginx/Nginx.md", NGINX);
    await write(root, "04 Ressourcen/Hydro/Hydro.md", HYDRO);
    const idx = createSemanticIndex({ embedder: createFakeEmbedder(), vaultRoot: root, indexPath });
    await idx.reconcile();
    const hits = await idx.searchText("Reverse Proxy TLS Server", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe("04 Ressourcen/Nginx/Nginx.md");
    expect(hits[0]!.heading).toBe("Setup");
  });

  test("minScore filters weak hits", async () => {
    const { root, indexPath } = await tmpVault();
    await write(root, "a.md", NGINX);
    const idx = createSemanticIndex({ embedder: createFakeEmbedder(), vaultRoot: root, indexPath });
    await idx.reconcile();
    const strong = await idx.searchText("Setup Reverse Proxy TLS Zertifikat Server", { minScore: 0.5 });
    const weak = await idx.searchText("völlig anderes Thema Banane", { minScore: 0.5 });
    expect(weak).toHaveLength(0);
    expect(strong.length).toBeGreaterThan(0);
  });

  test("excludePath and excludeDirs are respected", async () => {
    const { root, indexPath } = await tmpVault();
    await write(root, "02 Projekte/P.md", NGINX);
    await write(root, "06 Archiv/Old.md", NGINX);
    const idx = createSemanticIndex({ embedder: createFakeEmbedder(), vaultRoot: root, indexPath });
    await idx.reconcile();
    const hits = await idx.searchText("Reverse Proxy TLS", {
      excludePath: "02 Projekte/P.md",
      excludeDirs: ["06 Archiv/"],
    });
    expect(hits.every((h) => h.path !== "02 Projekte/P.md")).toBe(true);
    expect(hits.every((h) => !h.path.startsWith("06 Archiv/"))).toBe(true);
  });

  test("hash cache: a second reconcile with no changes embeds nothing new", async () => {
    const { root, indexPath } = await tmpVault();
    await write(root, "a.md", NGINX);
    await write(root, "b.md", HYDRO);
    const e = countingEmbedder();
    const idx = createSemanticIndex({ embedder: e, vaultRoot: root, indexPath });
    await idx.reconcile();
    const after1 = e.passagesEmbedded;
    expect(after1).toBeGreaterThan(0);
    await idx.reconcile();
    expect(e.passagesEmbedded).toBe(after1); // nothing re-embedded
  });

  test("changing one file re-embeds only its changed section", async () => {
    const { root, indexPath } = await tmpVault();
    await write(root, "a.md", NGINX);
    await write(root, "b.md", HYDRO);
    const e = countingEmbedder();
    const idx = createSemanticIndex({ embedder: e, vaultRoot: root, indexPath });
    await idx.reconcile();
    const baseline = e.passagesEmbedded;
    await write(root, "a.md", NGINX.replace("Server.", "Server und Loadbalancer."));
    await idx.reconcile();
    expect(e.passagesEmbedded).toBe(baseline + 1); // exactly one changed section
  });

  test("persistence round-trips: a fresh instance loads vectors without re-embedding", async () => {
    const { root, indexPath } = await tmpVault();
    await write(root, "a.md", NGINX);
    const e1 = countingEmbedder();
    const idx1 = createSemanticIndex({ embedder: e1, vaultRoot: root, indexPath });
    await idx1.reconcile();
    expect(e1.passagesEmbedded).toBeGreaterThan(0);

    const e2 = countingEmbedder();
    const idx2 = createSemanticIndex({ embedder: e2, vaultRoot: root, indexPath });
    await idx2.init(); // loads persisted cache, then reconciles
    expect(e2.passagesEmbedded).toBe(0); // all served from disk
    const hits = await idx2.searchText("Reverse Proxy TLS", {});
    expect(hits.length).toBeGreaterThan(0);
  });

  test("header mismatch (different embedder id) discards persisted cache and rebuilds", async () => {
    const { root, indexPath } = await tmpVault();
    await write(root, "a.md", NGINX);
    const idx1 = createSemanticIndex({ embedder: createFakeEmbedder(), vaultRoot: root, indexPath });
    await idx1.reconcile();

    // A different embedder id → persisted vectors are not trusted.
    const e2 = countingEmbedder("different@v9");
    const idx2 = createSemanticIndex({ embedder: e2, vaultRoot: root, indexPath });
    await idx2.init();
    expect(e2.passagesEmbedded).toBeGreaterThan(0); // had to re-embed
  });

  test("corrupt index file does not crash; it rebuilds", async () => {
    const { root, indexPath } = await tmpVault();
    await write(root, "a.md", NGINX);
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, "{ this is not valid json", "utf8");
    const idx = createSemanticIndex({ embedder: createFakeEmbedder(), vaultRoot: root, indexPath });
    await expect(idx.init()).resolves.toBeUndefined();
    const hits = await idx.searchText("Reverse Proxy", {});
    expect(hits.length).toBeGreaterThan(0);
  });

  test("concurrent reconcile() calls are serialized (no overlapping embeds)", async () => {
    const { root, indexPath } = await tmpVault();
    await write(root, "a.md", NGINX);
    await write(root, "b.md", HYDRO);
    const base = createFakeEmbedder();
    let active = 0;
    let violated = false;
    const slow: Embedder = {
      dim: base.dim,
      id: base.id,
      embedPassages: async (texts) => {
        if (active > 0) violated = true; // another embed already in flight → reconciles overlapped
        active++;
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return base.embedPassages(texts);
      },
      embedQuery: (t) => base.embedQuery(t),
    };
    const idx = createSemanticIndex({ embedder: slow, vaultRoot: root, indexPath });
    await Promise.all([idx.reconcile(), idx.reconcile(), idx.reconcile()]);
    expect(violated).toBe(false);
    expect(idx.size()).toBe(2); // both sections present, none dropped by a racing GC
  });

  test("search hits carry the full section text, not just a snippet", async () => {
    const { root, indexPath } = await tmpVault();
    const longBody = "EINZIGARTIGERSENTINEL " + "Fülltext Inhalt Absatz ".repeat(30); // > 200 chars
    await write(root, "a.md", `---\ntags: []\n---\n\n# T\n\n## Lang\n\n${longBody}\n`);
    const idx = createSemanticIndex({ embedder: createFakeEmbedder(), vaultRoot: root, indexPath });
    await idx.reconcile();
    const hits = await idx.searchText("EINZIGARTIGERSENTINEL Fülltext Inhalt", { limit: 1 });
    expect(hits[0]!.text).toContain("EINZIGARTIGERSENTINEL");
    expect(hits[0]!.text.length).toBeGreaterThan(200); // full section, not the 200-char snippet
  });

  test("label() maps scores to bands using SIM thresholds", () => {
    expect(label(SIM.high + 0.01)).toBe("sehr ähnlich");
    expect(label((SIM.related + SIM.high) / 2)).toBe("verwandt");
    expect(label(SIM.related - 0.1)).toBe("eher anders");
  });
});

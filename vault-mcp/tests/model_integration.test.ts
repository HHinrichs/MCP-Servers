import { afterEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTransformersEmbedder, cosine, EMBED_DIM } from "../src/lib/embeddings.js";
import { createSemanticIndex } from "../src/lib/semantic_index.js";
import { setSemanticIndex } from "../src/lib/index_singleton.js";
import { askVaultTool } from "../src/tools/ask_vault.js";

// Loads the real multilingual-e5-small model (~120 MB download on first run).
// Opt-in so the default suite stays fast and offline: RUN_MODEL_TESTS=1.
const run = process.env.RUN_MODEL_TESTS === "1";
(run ? describe : describe.skip)("real multilingual-e5-small model", () => {
  afterEach(() => setSemanticIndex(null));

  test("ask_vault retrieves the right section for a real question and gates noise", async () => {
    process.env.EMBED_ALLOW_REMOTE = "true";
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "askv-real-"));
    await fs.mkdir(path.join(root, "03 Bereiche", "Coolify"), { recursive: true });
    await fs.writeFile(
      path.join(root, "03 Bereiche", "Coolify", "Coolify.md"),
      "---\ntags: []\n---\n\n# Coolify\n\n## Token rotieren\n\nNeuen Bearer-Token generieren, im Coolify-UI als ENV setzen, dann alle laufenden Client-Sessions neu starten — sonst 401.\n",
    );
    await fs.writeFile(
      path.join(root, "Hydro.md"),
      "---\ntags: []\n---\n\n# Hydroponik\n\n## Nährlösung\n\npH-Wert und EC der Nährlösung steuern das Pflanzenwachstum.\n",
    );
    const indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "askv-store-")), "i.json");
    const idx = createSemanticIndex({ embedder: createTransformersEmbedder(), vaultRoot: root, indexPath });
    await idx.reconcile();
    setSemanticIndex(idx);

    const hit = await askVaultTool.handler({ question: "Wie erneuere ich den Token?" });
    expect(hit.content[0]!.text).toContain("Token rotieren");
    expect(hit.content[0]!.text).toContain("401"); // full section body returned

    const miss = await askVaultTool.handler({ question: "Wie backe ich einen Schokoladenkuchen?" });
    expect(miss.content[0]!.text).toMatch(/nichts Belastbares/i);
  }, 180000);
  test(
    "produces 384-dim vectors and ranks DE↔EN cross-lingual related > unrelated",
    async () => {
      process.env.EMBED_ALLOW_REMOTE = "true"; // allow the one-time download
      const e = createTransformersEmbedder();
      const [proxy] = await e.embedPassages(["Nginx ist ein Reverse Proxy der TLS terminiert"]);
      expect(proxy!.length).toBe(EMBED_DIM);

      const enRelated = await e.embedQuery("reverse proxy terminating TLS with nginx");
      const unrelated = await e.embedQuery("Hydroponik Nährlösung pH Wert für die Pflanzen");
      const sRel = cosine(proxy!, enRelated);
      const sUnrel = cosine(proxy!, unrelated);
      console.log(`[model] DE↔EN related=${sRel.toFixed(3)} unrelated=${sUnrel.toFixed(3)}`);
      expect(sRel).toBeGreaterThan(sUnrel);
    },
    180000,
  );
});

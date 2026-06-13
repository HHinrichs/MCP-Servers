import { describe, expect, test } from "vitest";
import { createTransformersEmbedder, cosine, EMBED_DIM } from "../src/lib/embeddings.js";

// Loads the real multilingual-e5-small model (~120 MB download on first run).
// Opt-in so the default suite stays fast and offline: RUN_MODEL_TESTS=1.
const run = process.env.RUN_MODEL_TESTS === "1";
(run ? describe : describe.skip)("real multilingual-e5-small model", () => {
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

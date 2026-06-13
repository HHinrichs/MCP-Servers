import { describe, expect, test } from "vitest";
import { cosine, createFakeEmbedder } from "../src/lib/embeddings.js";

describe("FakeEmbedder", () => {
  const e = createFakeEmbedder();

  test("is deterministic and L2-normalized", async () => {
    const [a] = await e.embedPassages(["Bewässerung der Pflanzen"]);
    const [b] = await e.embedPassages(["Bewässerung der Pflanzen"]);
    expect(Array.from(a!)).toEqual(Array.from(b!));
    let norm = 0;
    for (const v of a!) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  test("query and passage embedding of the same text match (prefix-agnostic fake)", async () => {
    const [p] = await e.embedPassages(["Reverse Proxy mit Nginx"]);
    const q = await e.embedQuery("Reverse Proxy mit Nginx");
    expect(cosine(p!, q)).toBeCloseTo(1, 5);
  });

  test("shared-token texts score higher than disjoint texts", async () => {
    const [base] = await e.embedPassages(["Nginx Reverse Proxy TLS Zertifikat"]);
    const related = await e.embedQuery("Nginx Proxy mit TLS");
    const unrelated = await e.embedQuery("Hydroponik Nährlösung pH Wert");
    expect(cosine(base!, related)).toBeGreaterThan(cosine(base!, unrelated));
  });

  test("cosine of identical normalized vectors is 1, orthogonal is 0", async () => {
    const [v] = await e.embedPassages(["abc def"]);
    expect(cosine(v!, v!)).toBeCloseTo(1, 5);
    const [x] = await e.embedPassages(["alpha"]);
    const [y] = await e.embedPassages(["omega"]);
    // different single tokens hash to (almost certainly) different dims → orthogonal
    expect(cosine(x!, y!)).toBeCloseTo(0, 5);
  });
});

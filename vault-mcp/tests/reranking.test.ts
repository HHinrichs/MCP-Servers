import { describe, expect, test } from "vitest";
import { createFakeReranker } from "../src/lib/reranking.js";

describe("FakeReranker", () => {
  const r = createFakeReranker();

  test("scores each passage by shared-token overlap with the query, in input order", async () => {
    const scores = await r.rerank("nginx tls proxy", [
      "Hydroponik pH Nährlösung Dosierung", // 0 overlap
      "nginx reverse proxy tls config", // 3 overlap (nginx, proxy, tls)
      "tls zertifikat erneuern", // 1 overlap (tls)
    ]);
    expect(scores).toHaveLength(3);
    expect(scores[1]!).toBeGreaterThan(scores[2]!);
    expect(scores[2]!).toBeGreaterThan(scores[0]!);
  });

  test("returns an empty array for no passages", async () => {
    expect(await r.rerank("frage", [])).toEqual([]);
  });

  test("is deterministic", async () => {
    const a = await r.rerank("a b c", ["b c d", "x y z"]);
    const b = await r.rerank("a b c", ["b c d", "x y z"]);
    expect(a).toEqual(b);
  });
});

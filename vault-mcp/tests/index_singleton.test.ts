import { describe, expect, test } from "vitest";
import path from "node:path";
import { resolveIndexPath } from "../src/lib/index_singleton.js";

describe("resolveIndexPath", () => {
  const repo = path.resolve("/data/vault/repo");

  test("defaults to a sibling of the repo, outside it", () => {
    const p = resolveIndexPath(repo);
    expect(p).toBe(path.resolve("/data/vault/semantic-index.json"));
    expect(p.startsWith(repo + path.sep)).toBe(false);
  });

  test("accepts an explicit path outside the repo", () => {
    const p = resolveIndexPath(repo, "/var/cache/idx.json");
    expect(p).toBe(path.resolve("/var/cache/idx.json"));
  });

  test("throws when the index path is inside the repo (would be auto-committed)", () => {
    expect(() => resolveIndexPath(repo, "/data/vault/repo/.idx.json")).toThrow(/OUTSIDE the vault repo/);
    expect(() => resolveIndexPath(repo, repo)).toThrow(/OUTSIDE the vault repo/);
  });
});

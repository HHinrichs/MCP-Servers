import { describe, expect, test, beforeEach } from "vitest";
import { createFakeGitHub } from "../src/lib/github.js";
import { makeWriter, getWriteHealth, __resetWriteHealthForTests } from "../src/lib/writes.js";

beforeEach(() => __resetWriteHealthForTests());

describe("writeToOrigin", () => {
  test("commits the transformed content and mirrors it", async () => {
    const gh = createFakeGitHub({ "a.md": "start" });
    const mirrored: Record<string, string | null> = {};
    const w = makeWriter(gh, async (rel, content) => {
      mirrored[rel] = content;
    });
    await w.writeToOrigin("a.md", (raw) => (raw ?? "") + "\n+line", "msg");
    expect(await gh.getFileContent("a.md", (await gh.getHead()).commitSha)).toBe("start\n+line");
    expect(mirrored["a.md"]).toBe("start\n+line");
    expect(getWriteHealth().lastWriteError).toBeNull();
  });

  test("retries the transform on a CAS conflict without losing the edit", async () => {
    const gh = createFakeGitHub({ "a.md": "base" });
    gh.forceConflictOnce(); // first commit attempt throws RefMovedError
    const w = makeWriter(gh, async () => {});
    await w.writeToOrigin("a.md", (raw) => (raw ?? "") + "\nX", "msg");
    expect(await gh.getFileContent("a.md", (await gh.getHead()).commitSha)).toBe("base\nX");
  });

  test("propagates a hard failure and records write-health error", async () => {
    const gh = createFakeGitHub({ "a.md": "base" });
    const w = makeWriter(
      { ...gh, commitFiles: async () => { throw new Error("boom"); } } as typeof gh,
      async () => {},
    );
    await expect(w.writeToOrigin("a.md", (r) => (r ?? "") + "y", "msg")).rejects.toThrow();
    expect(getWriteHealth().lastWriteError).toContain("boom");
  });
});

describe("writeMulti", () => {
  test("commits multiple files atomically and mirrors each", async () => {
    const gh = createFakeGitHub({ "from.md": "body" });
    const mirrored: Record<string, string | null> = {};
    const w = makeWriter(gh, async (rel, content) => {
      mirrored[rel] = content;
    });
    await w.writeMulti(
      ["from.md"],
      (raws) => [
        { path: "from.md", delete: true },
        { path: "to.md", content: raws[0] ?? "" },
      ],
      "move",
    );
    const head = (await gh.getHead()).commitSha;
    expect(await gh.getFileContent("from.md", head)).toBeNull();
    expect(await gh.getFileContent("to.md", head)).toBe("body");
    expect(mirrored["from.md"]).toBeNull();
    expect(mirrored["to.md"]).toBe("body");
  });
});

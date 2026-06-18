import { describe, expect, test } from "vitest";
import { createFakeGitHub, RefMovedError } from "../src/lib/github.js";

describe("FakeGitHub", () => {
  test("getFileContent returns null for a missing path", async () => {
    const gh = createFakeGitHub({});
    const head = await gh.getHead();
    expect(await gh.getFileContent("missing.md", head.commitSha)).toBeNull();
  });

  test("commitFiles writes content and advances HEAD", async () => {
    const gh = createFakeGitHub({ "a.md": "one" });
    const head = await gh.getHead();
    await gh.commitFiles(head.commitSha, [{ path: "a.md", content: "one\ntwo" }], "msg");
    const head2 = await gh.getHead();
    expect(head2.commitSha).not.toBe(head.commitSha);
    expect(await gh.getFileContent("a.md", head2.commitSha)).toBe("one\ntwo");
  });

  test("commitFiles with a stale base sha throws RefMovedError", async () => {
    const gh = createFakeGitHub({ "a.md": "one" });
    const stale = (await gh.getHead()).commitSha;
    // someone else commits first, advancing HEAD
    await gh.commitFiles(stale, [{ path: "a.md", content: "x" }], "other");
    // our commit against the now-stale base must be rejected
    await expect(
      gh.commitFiles(stale, [{ path: "a.md", content: "y" }], "ours"),
    ).rejects.toBeInstanceOf(RefMovedError);
  });

  test("commitFiles can delete a path", async () => {
    const gh = createFakeGitHub({ "a.md": "one", "b.md": "two" });
    const head = await gh.getHead();
    await gh.commitFiles(head.commitSha, [{ path: "a.md", delete: true }], "rm");
    const head2 = await gh.getHead();
    expect(await gh.getFileContent("a.md", head2.commitSha)).toBeNull();
    expect(await gh.getFileContent("b.md", head2.commitSha)).toBe("two");
  });
});

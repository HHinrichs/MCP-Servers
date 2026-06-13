import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";

vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { splitNoteTool } from "../src/tools/split_note.js";
import { vaultPath } from "../src/lib/vault.js";

const SOURCE_BODY = [
  "---",
  "tags: [projekt]",
  "erstellt: 2026-06-01",
  "---",
  "",
  "# Quelle",
  "",
  "## Alpha",
  "",
  "- a1",
  "",
  "### Detail",
  "",
  "- a2",
  "",
  "## Beta",
  "",
  "- b1",
  "",
].join("\n");

async function makeSource(dir: string): Promise<string> {
  const abs = path.join(vaultPath(), dir, "Quelle.md");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, SOURCE_BODY, "utf8");
  return abs;
}

describe("split_note", () => {
  test("extracts a ## section (incl. ### subsections) into a new linked note", async () => {
    const dir = `t-${randomUUID()}`;
    const srcAbs = await makeSource(dir);
    const res = await splitNoteTool.handler({
      source: `${dir}/Quelle.md`,
      section: "Alpha",
      target: `${dir}/Quelle/Subthema.md`,
    });
    expect(res.isError).toBeUndefined();

    // Target: carries the extracted content, a backlink, and the source tags.
    const target = matter(
      await fs.readFile(path.join(vaultPath(), dir, "Quelle", "Subthema.md"), "utf8"),
    );
    expect(target.content).toContain("# Subthema");
    expect(target.content).toContain("[[Quelle]]");
    expect(target.content).toContain("- a1");
    expect(target.content).toContain("### Detail");
    expect(target.content).toContain("- a2");
    expect(target.data.tags).toEqual(["projekt"]);

    // Source: header stays as a stub with a wikilink, content is gone,
    // neighbouring section untouched.
    const source = matter(await fs.readFile(srcAbs, "utf8"));
    expect(source.content).toContain("## Alpha");
    expect(source.content).toContain("[[Subthema]]");
    expect(source.content).not.toContain("- a1");
    expect(source.content).not.toContain("### Detail");
    expect(source.content).toContain("## Beta");
    expect(source.content).toContain("- b1");
  });

  test("errors when the section does not exist", async () => {
    const dir = `t-${randomUUID()}`;
    await makeSource(dir);
    const res = await splitNoteTool.handler({
      source: `${dir}/Quelle.md`,
      section: "Gibtsnicht",
      target: `${dir}/Quelle/X.md`,
    });
    expect(res.isError).toBe(true);
  });

  test("errors when the target already exists and leaves the source untouched", async () => {
    const dir = `t-${randomUUID()}`;
    const srcAbs = await makeSource(dir);
    const targetAbs = path.join(vaultPath(), dir, "Quelle", "Subthema.md");
    await fs.mkdir(path.dirname(targetAbs), { recursive: true });
    await fs.writeFile(targetAbs, "# schon da\n", "utf8");
    const res = await splitNoteTool.handler({
      source: `${dir}/Quelle.md`,
      section: "Alpha",
      target: `${dir}/Quelle/Subthema.md`,
    });
    expect(res.isError).toBe(true);
    expect(await fs.readFile(srcAbs, "utf8")).toBe(SOURCE_BODY);
  });

  test("errors when the source is missing", async () => {
    const dir = `t-${randomUUID()}`;
    const res = await splitNoteTool.handler({
      source: `${dir}/Quelle.md`,
      section: "Alpha",
      target: `${dir}/X.md`,
    });
    expect(res.isError).toBe(true);
  });

  test("refuses protected root files as source", async () => {
    const res = await splitNoteTool.handler({
      source: "AGENTS.md",
      section: "Routing",
      target: "01 Inbox/X.md",
    });
    expect(res.isError).toBe(true);
  });
});

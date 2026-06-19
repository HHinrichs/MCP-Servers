import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { deleteSectionTool } from "../src/tools/delete_section.js";
import { vaultPath } from "../src/lib/vault.js";

const NOTE = "---\ntags: [projekt]\n---\n\n# Q\n\n## Alpha\n\n- alt\n\n## Beta\n\n- b1\n";

async function makeNote(rel: string, content = NOTE): Promise<string> {
  const abs = path.join(vaultPath(), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

describe("delete_section", () => {
  test("removes the section when expected_current matches", async () => {
    const dir = `t-${randomUUID()}`;
    const abs = await makeNote(`${dir}/N.md`);
    const res = await deleteSectionTool.handler({
      file: `${dir}/N.md`, section: "Alpha", expected_current: "- alt",
    });
    expect(res.isError).toBeUndefined();
    const out = await fs.readFile(abs, "utf8");
    expect(out).not.toContain("## Alpha");
    expect(out).toContain("## Beta");
  });

  test("fail-loud on guard mismatch (no write)", async () => {
    const dir = `t-${randomUUID()}`;
    const abs = await makeNote(`${dir}/N.md`);
    const res = await deleteSectionTool.handler({
      file: `${dir}/N.md`, section: "Alpha", expected_current: "- anders",
    });
    expect(res.isError).toBe(true);
    expect(await fs.readFile(abs, "utf8")).toBe(NOTE);
  });

  test("errors when the section is missing", async () => {
    const dir = `t-${randomUUID()}`;
    await makeNote(`${dir}/N.md`);
    const res = await deleteSectionTool.handler({
      file: `${dir}/N.md`, section: "Nope", expected_current: "x",
    });
    expect(res.isError).toBe(true);
  });

  test("refuses protected root files", async () => {
    const res = await deleteSectionTool.handler({
      file: "CLAUDE.md", section: "X", expected_current: "y",
    });
    expect(res.isError).toBe(true);
  });
});

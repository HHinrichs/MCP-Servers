import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { deleteNoteTool } from "../src/tools/delete_note.js";
import { vaultPath } from "../src/lib/vault.js";

async function makeNote(rel: string, content = "# Note\n"): Promise<string> {
  const abs = path.join(vaultPath(), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

describe("delete_note", () => {
  test("soft-deletes: moves to 06 Archiv/ preserving structure, original gone", async () => {
    const dir = `t-${randomUUID()}`;
    const srcAbs = await makeNote(`${dir}/N.md`);
    const res = await deleteNoteTool.handler({ path: `${dir}/N.md` });
    expect(res.isError).toBeUndefined();
    await expect(fs.access(path.join(vaultPath(), "06 Archiv", dir, "N.md"))).resolves.toBeUndefined();
    await expect(fs.access(srcAbs)).rejects.toThrow();
  });

  test("adds a timestamp suffix if the archive target already exists", async () => {
    const dir = `t-${randomUUID()}`;
    await makeNote(`${dir}/N.md`);
    await makeNote(`06 Archiv/${dir}/N.md`, "# alt\n");
    const res = await deleteNoteTool.handler({ path: `${dir}/N.md` });
    expect(res.isError).toBeUndefined();
    const archiveDir = path.join(vaultPath(), "06 Archiv", dir);
    const entries = await fs.readdir(archiveDir);
    expect(entries.length).toBe(2);
    // original archive entry untouched
    expect(await fs.readFile(path.join(archiveDir, "N.md"), "utf8")).toBe("# alt\n");
    // the suffixed entry carries the soft-deleted source content
    const suffixed = entries.find((e) => e !== "N.md");
    expect(suffixed).toBeDefined();
    expect(await fs.readFile(path.join(archiveDir, suffixed!), "utf8")).toContain("# Note");
  });

  test("errors when the note is missing", async () => {
    const dir = `t-${randomUUID()}`;
    const res = await deleteNoteTool.handler({ path: `${dir}/missing.md` });
    expect(res.isError).toBe(true);
  });

  test("refuses protected root files", async () => {
    await makeNote("AGENTS.md", "# Regeln\n");
    const res = await deleteNoteTool.handler({ path: "AGENTS.md" });
    expect(res.isError).toBe(true);
    await expect(fs.access(path.join(vaultPath(), "AGENTS.md"))).resolves.toBeUndefined();
  });
});

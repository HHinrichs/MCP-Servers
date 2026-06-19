import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";

vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { createNoteTool } from "../src/tools/create_note.js";
import { vaultPath } from "../src/lib/vault.js";

describe("create_note", () => {
  test("creates a new note, wrapping bare content with frontmatter + H1", async () => {
    const dir = `t-${randomUUID()}`;
    const res = await createNoteTool.handler({ path: `${dir}/Neu.md`, content: "Inhalt hier" });
    expect(res.isError).toBeUndefined();
    const out = matter(await fs.readFile(path.join(vaultPath(), dir, "Neu.md"), "utf8"));
    expect(out.content).toContain("# Neu");
    expect(out.content).toContain("Inhalt hier");
    expect(out.data).toHaveProperty("erstellt");
  });

  test("refuses to overwrite an existing note", async () => {
    const dir = `t-${randomUUID()}`;
    const abs = path.join(vaultPath(), dir, "Da.md");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "# schon da\n", "utf8");
    const res = await createNoteTool.handler({ path: `${dir}/Da.md`, content: "neu" });
    expect(res.isError).toBe(true);
    expect(await fs.readFile(abs, "utf8")).toBe("# schon da\n");
  });

  test("refuses protected root files", async () => {
    const res = await createNoteTool.handler({ path: "AGENTS.md", content: "x" });
    expect(res.isError).toBe(true);
  });

  test("refuses a path that escapes the vault", async () => {
    const res = await createNoteTool.handler({ path: "../escape.md", content: "x" });
    expect(res.isError).toBe(true);
  });
});

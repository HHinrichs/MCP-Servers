import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// markDirty schedules a 30s debounced git commit — neutralize it so tests
// neither hang on the timer nor run git against the throwaway test vault.
vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { moveNoteTool } from "../src/tools/move_note.js";
import { vaultPath } from "../src/lib/vault.js";

async function makeNote(rel: string, content = "# Note\n"): Promise<string> {
  const abs = path.join(vaultPath(), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

describe("move_note", () => {
  test("moves a normal note", async () => {
    const dir = `t-${randomUUID()}`;
    await makeNote(`${dir}/src.md`);
    const res = await moveNoteTool.handler({ from: `${dir}/src.md`, to: `${dir}/dst.md` });
    expect(res.isError).toBeUndefined();
    await expect(fs.access(path.join(vaultPath(), dir, "dst.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(vaultPath(), dir, "src.md"))).rejects.toThrow();
  });

  test("refuses to overwrite an existing target", async () => {
    const dir = `t-${randomUUID()}`;
    await makeNote(`${dir}/src.md`);
    await makeNote(`${dir}/dst.md`);
    const res = await moveNoteTool.handler({ from: `${dir}/src.md`, to: `${dir}/dst.md` });
    expect(res.isError).toBe(true);
  });

  test("refuses to move the root AGENTS.md (server rule source)", async () => {
    await makeNote("AGENTS.md", "# Regeln\n");
    const res = await moveNoteTool.handler({ from: "AGENTS.md", to: "06 Archiv/AGENTS.md" });
    expect(res.isError).toBe(true);
    await expect(fs.access(path.join(vaultPath(), "AGENTS.md"))).resolves.toBeUndefined();
  });

  test("refuses to move the root CLAUDE.md", async () => {
    await makeNote("CLAUDE.md", "@AGENTS.md\n");
    const res = await moveNoteTool.handler({ from: "./CLAUDE.md", to: "01 Inbox/CLAUDE.md" });
    expect(res.isError).toBe(true);
  });
});

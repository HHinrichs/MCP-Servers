// Test setup: install a filesystem-backed Writer so tool/job handlers (which
// now write origin-first via getWriter()) operate on the throwaway test vault.
// This mirrors the old local read-modify-write behavior, so the existing
// fs-based tool assertions keep working without per-test wiring.
import { promises as fs } from "node:fs";
import path from "node:path";
import { vaultPath } from "../src/lib/vault.js";
import { setWriter } from "../src/lib/writer_singleton.js";
import type { Writer } from "../src/lib/writes.js";

async function readRel(rel: string): Promise<string | null> {
  try {
    return await fs.readFile(vaultPath(rel), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeRel(rel: string, content: string | null): Promise<void> {
  const abs = vaultPath(rel);
  if (content === null) {
    await fs.rm(abs, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

const fsWriter: Writer = {
  async writeToOrigin(rel, transform) {
    await writeRel(rel, transform(await readRel(rel)));
  },
  async writeMulti(rels, transform) {
    const raws = await Promise.all(rels.map(readRel));
    for (const c of transform(raws)) {
      await writeRel(c.path, c.delete ? null : c.content ?? "");
    }
  },
};

setWriter(fsWriter);

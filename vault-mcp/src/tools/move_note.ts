import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { markDirty } from "../lib/git.js";
import { resolveVaultPath } from "../lib/vault.js";

export const moveNoteTool = {
  name: "move_note",
  description:
    "Move or rename a note within the vault. Both paths are relative to the vault root. Use to promote an inbox entry into a project/area, or to rename.",
  inputSchema: {
    from: z.string().min(1).describe("Source path, relative to vault root."),
    to: z.string().min(1).describe("Destination path, relative to vault root."),
  },
  handler: async ({ from, to }: { from: string; to: string }) => {
    const src = resolveVaultPath(from);
    const dst = resolveVaultPath(to);
    try {
      await fs.access(src);
    } catch {
      return {
        content: [{ type: "text" as const, text: `Quelle existiert nicht: ${from}` }],
        isError: true,
      };
    }
    try {
      await fs.access(dst);
      return {
        content: [{ type: "text" as const, text: `Ziel existiert bereits, abgebrochen: ${to}` }],
        isError: true,
      };
    } catch {
      // OK, doesn't exist yet
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    markDirty(`move_note ${from} -> ${to}`);
    return {
      content: [{ type: "text" as const, text: `Verschoben: ${from} → ${to}` }],
    };
  },
};

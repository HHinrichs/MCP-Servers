import { z } from "zod";
import { promises as fs } from "node:fs";
import { resolveVaultPath } from "../lib/vault.js";

export const readNoteTool = {
  name: "read_note",
  description:
    "Read the full content of a note. Path is relative to the vault root, e.g. '02 Projekte/Homegrow Controller.md'.",
  inputSchema: {
    path: z.string().min(1).describe("Vault-relative path to the note."),
  },
  handler: async ({ path: relPath }: { path: string }) => {
    const abs = resolveVaultPath(relPath);
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          content: [{ type: "text" as const, text: `Notiz nicht gefunden: ${relPath}` }],
          isError: true,
        };
      }
      throw e;
    }
    return { content: [{ type: "text" as const, text: content }] };
  },
};

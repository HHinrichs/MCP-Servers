import { z } from "zod";
import { promises as fs } from "node:fs";
import { getWriter } from "../lib/writer_singleton.js";
import { isProtectedRootFile, resolveVaultPath } from "../lib/vault.js";

export const moveNoteTool = {
  name: "move_note",
  description:
    "Move or rename a note within the vault. Both paths are relative to the vault root. Typical uses: archive a triaged inbox note to '06 Archiv/Inbox/' (after merging its content via add_to_*), or rename a note.",
  inputSchema: {
    from: z.string().min(1).describe("Source path, relative to vault root."),
    to: z.string().min(1).describe("Destination path, relative to vault root."),
  },
  handler: async ({ from, to }: { from: string; to: string }) => {
    if (isProtectedRootFile(from) || isProtectedRootFile(to)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "AGENTS.md / CLAUDE.md im Vault-Root sind die Regelquelle des Servers und dürfen nicht verschoben werden.",
          },
        ],
        isError: true,
      };
    }
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
    await getWriter().writeMulti(
      [from],
      (raws) => {
        const content = raws[0];
        if (content == null) throw new Error(`source vanished: ${from}`);
        return [
          { path: from, delete: true },
          { path: to, content },
        ];
      },
      `move_note ${from} -> ${to}`,
    );
    return {
      content: [{ type: "text" as const, text: `Verschoben: ${from} → ${to}` }],
    };
  },
};

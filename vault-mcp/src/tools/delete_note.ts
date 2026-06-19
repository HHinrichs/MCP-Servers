import { z } from "zod";
import { getWriter } from "../lib/writer_singleton.js";
import { isProtectedRootFile, readIfExists, resolveVaultPath, timestampBerlin } from "../lib/vault.js";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const deleteNoteTool = {
  name: "delete_note",
  description:
    "Soft-delete a whole note: move it to '06 Archiv/<original path>' instead of erasing it (always recoverable as a moved file, plus git). The folder structure is preserved; if the archive target already exists, a timestamp suffix is added. AGENTS.md / CLAUDE.md are protected. To remove just a section within a note, use delete_section.",
  inputSchema: {
    path: z.string().min(1).describe("Vault-relative path of the note to soft-delete."),
  },
  handler: async ({ path: from }: { path: string }) => {
    if (isProtectedRootFile(from)) {
      return err("AGENTS.md / CLAUDE.md im Vault-Root sind die Regelquelle des Servers und dürfen nicht gelöscht werden.");
    }
    let srcAbs: string;
    try {
      srcAbs = resolveVaultPath(from);
    } catch {
      return err(`Pfad verlässt das Vault, abgebrochen: ${from}`);
    }
    if ((await readIfExists(srcAbs)) === null) {
      return err(`Notiz existiert nicht: ${from}`);
    }
    const relPosix = from.split(/[\\/]/).join("/").replace(/^(\.\/)+/, "");
    let archiveRel = `06 Archiv/${relPosix}`;
    if ((await readIfExists(resolveVaultPath(archiveRel))) !== null) {
      const stamp = timestampBerlin().replace(/[: ]/g, "-");
      const stamped = archiveRel.replace(/\.md$/, `_${stamp}.md`);
      archiveRel = stamped !== archiveRel ? stamped : `${archiveRel}_${stamp}`;
    }
    await getWriter().writeMulti(
      [from],
      (raws) => {
        const content = raws[0];
        if (content == null) throw new Error(`source vanished: ${from}`);
        return [
          { path: from, delete: true },
          { path: archiveRel, content },
        ];
      },
      `delete_note ${from} -> ${archiveRel}`,
    );
    return { content: [{ type: "text" as const, text: `Soft-deleted: ${from} → ${archiveRel}` }] };
  },
};

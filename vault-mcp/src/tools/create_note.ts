import { z } from "zod";
import path from "node:path";
import { getWriter } from "../lib/writer_singleton.js";
import { createNoteFromContent } from "../lib/transforms.js";
import { isProtectedRootFile, readIfExists, resolveVaultPath } from "../lib/vault.js";
import { NoteExistsError } from "../lib/errors.js";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const createNoteTool = {
  name: "create_note",
  description:
    "Create a NEW standalone note at an arbitrary vault path — e.g. a marketing asset in '00 Kontext/', which add_to_context (curated to the 4 strategy files) cannot do. Refuses to overwrite an existing file; use edit_section or add_to_* for existing notes. Minimal frontmatter (tags, erstellt, updated) + an H1 from the filename are added automatically unless your content already starts with a '---' frontmatter block. For routed appends, prefer add_to_project/area/resource/context.",
  inputSchema: {
    path: z
      .string()
      .min(1)
      .regex(/\.md$/, "Pfad muss auf .md enden")
      .describe("Vault-relative path of the NEW note, must end in .md and not exist yet, e.g. '00 Kontext/Marketing-Video-Skript.md'."),
    content: z.string().min(1).describe("Markdown content for the note."),
  },
  handler: async ({ path: rel, content }: { path: string; content: string }) => {
    if (isProtectedRootFile(rel)) {
      return err("AGENTS.md / CLAUDE.md im Vault-Root sind die Regelquelle des Servers und dürfen nicht überschrieben werden.");
    }
    let abs: string;
    try {
      abs = resolveVaultPath(rel);
    } catch {
      return err(`Pfad verlässt das Vault, abgebrochen: ${rel}`);
    }
    if ((await readIfExists(abs)) !== null) {
      return err(`Existiert schon: ${rel}. Nutze edit_section oder add_to_* für bestehende Notizen.`);
    }
    const title = path.basename(rel, ".md");
    try {
      await getWriter().writeToOrigin(
        rel,
        (raw) => {
          if (raw !== null) throw new NoteExistsError(rel);
          return createNoteFromContent(content, title);
        },
        `create_note ${rel}`,
      );
    } catch (e) {
      if (e instanceof NoteExistsError) {
        return err(`Existiert schon: ${rel}. Nutze edit_section oder add_to_*.`);
      }
      throw e;
    }
    return { content: [{ type: "text" as const, text: `Neue Notiz angelegt: ${rel}` }] };
  },
};

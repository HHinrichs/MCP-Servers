import { z } from "zod";
import { getWriter } from "../lib/writer_singleton.js";
import { removeSection } from "../lib/transforms.js";
import { isProtectedRootFile, readIfExists, resolveVaultPath } from "../lib/vault.js";
import { SectionConflictError, SectionNotFoundError } from "../lib/errors.js";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const deleteSectionTool = {
  name: "delete_section",
  description:
    "Cleanup/dedup tool — remove a whole '## Section' (header + body + '###' subsections) from a note, in-place. This is in-place removal, recoverable only via git (not archived). FAIL-LOUD GUARD: read the section with read_note first and pass its current body as expected_current; on mismatch the delete is refused and the current content returned. For removing a whole note, use delete_note (soft-delete).",
  inputSchema: {
    file: z.string().min(1).describe("Vault-relative path of the note."),
    section: z.string().min(1).describe("Heading text of the '## Section' to remove, without '##'."),
    expected_current: z
      .string()
      .min(1)
      .describe("The section's current body (from read_note). Guard: if it no longer matches, the delete is refused."),
  },
  handler: async ({
    file,
    section,
    expected_current,
  }: {
    file: string;
    section: string;
    expected_current: string;
  }) => {
    if (isProtectedRootFile(file)) {
      return err("AGENTS.md / CLAUDE.md im Vault-Root sind die Regelquelle des Servers und dürfen nicht editiert werden.");
    }
    let abs: string;
    try {
      abs = resolveVaultPath(file);
    } catch {
      return err(`Pfad verlässt das Vault, abgebrochen: ${file}`);
    }
    if ((await readIfExists(abs)) === null) {
      return err(`Datei existiert nicht: ${file}`);
    }
    try {
      await getWriter().writeToOrigin(
        file,
        (raw) => {
          if (raw === null) throw new SectionNotFoundError(section);
          return removeSection(raw, section, expected_current);
        },
        `delete_section ${file} / ${section}`,
      );
    } catch (e) {
      if (e instanceof SectionConflictError) {
        return err(
          `Konflikt in '## ${section}' (${file}): der aktuelle Inhalt weicht von expected_current ab — nichts gelöscht.\n\nAktueller Inhalt:\n${e.actual}\n\nLies die Section neu (read_note) und wiederhole.`,
        );
      }
      if (e instanceof SectionNotFoundError) {
        return err(`Section '## ${section}' nicht gefunden in ${file}.`);
      }
      throw e;
    }
    return { content: [{ type: "text" as const, text: `'## ${section}' aus '${file}' entfernt.` }] };
  },
};

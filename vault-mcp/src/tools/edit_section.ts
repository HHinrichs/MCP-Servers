import { z } from "zod";
import { getWriter } from "../lib/writer_singleton.js";
import { replaceSectionContent } from "../lib/transforms.js";
import { isProtectedRootFile, readIfExists, resolveVaultPath } from "../lib/vault.js";
import { SectionConflictError, SectionNotFoundError } from "../lib/errors.js";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const editSectionTool = {
  name: "edit_section",
  description:
    "Correction tool — replace the body under a '## Section' of an existing note (incl. its '###' subsections, up to the next '##'/'#'). Append remains the default; use add_to_* for new entries. FAIL-LOUD GUARD: read the section with read_note first and pass its current body as expected_current; if the section changed underneath you, the write is refused and the current content is returned so you can re-read and retry. The '## Section' header is kept; only the body below it is replaced.",
  inputSchema: {
    file: z.string().min(1).describe("Vault-relative path of the note, e.g. '00 Kontext/Pitch.md'."),
    section: z.string().min(1).describe("Heading text of the '## Section' to replace, without '##'."),
    new_content: z.string().min(1).describe("New Markdown body for the section."),
    expected_current: z
      .string()
      .min(1)
      .describe("The section's current body (from read_note). Guard: if it no longer matches, the edit is refused."),
  },
  handler: async ({
    file,
    section,
    new_content,
    expected_current,
  }: {
    file: string;
    section: string;
    new_content: string;
    expected_current: string;
  }) => {
    if (isProtectedRootFile(file)) {
      return err("AGENTS.md / CLAUDE.md im Vault-Root sind die Regelquelle des Servers und dürfen nicht editiert werden.");
    }
    if ((await readIfExists(resolveVaultPath(file))) === null) {
      return err(`Datei existiert nicht: ${file}`);
    }
    try {
      await getWriter().writeToOrigin(
        file,
        (raw) => {
          if (raw === null) throw new SectionNotFoundError(section);
          return replaceSectionContent(raw, section, new_content, expected_current);
        },
        `edit_section ${file} / ${section}`,
      );
    } catch (e) {
      if (e instanceof SectionConflictError) {
        return err(
          `Konflikt in '## ${section}' (${file}): der aktuelle Inhalt weicht von expected_current ab — nichts geschrieben.\n\nAktueller Inhalt:\n${e.actual}\n\nLies die Section neu (read_note) und wiederhole.`,
        );
      }
      if (e instanceof SectionNotFoundError) {
        return err(`Section '## ${section}' nicht gefunden in ${file}.`);
      }
      throw e;
    }
    return { content: [{ type: "text" as const, text: `'## ${section}' in '${file}' ersetzt.` }] };
  },
};

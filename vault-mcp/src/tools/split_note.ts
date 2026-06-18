import { z } from "zod";
import path from "node:path";
import matter from "gray-matter";
import { getWriter } from "../lib/writer_singleton.js";
import { splitNoteContent } from "../lib/transforms.js";
import {
  escapeRegex,
  isProtectedRootFile,
  readIfExists,
  resolveVaultPath,
  timestampBerlin,
} from "../lib/vault.js";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const splitNoteTool = {
  name: "split_note",
  description:
    "Split a bloated note: extract one '## Section' (including its '###' subsections) into a new note and leave a [[Wikilink]] stub behind. Use when a size hint reports warn/hard and the section is thematically standalone. Target path follows the vault rules: for projects create a subfolder ('02 Projekte/<Project>/<Subtopic>.md'), for areas/resources add a sibling file in the same folder. The new note gets the source's tags and a backlink to the source.",
  inputSchema: {
    source: z
      .string()
      .min(1)
      .describe("Vault-relative path of the note to split, e.g. '02 Projekte/Homegrow Controller.md'."),
    section: z
      .string()
      .min(1)
      .describe("Heading text of the '## Section' to extract, without the '##' prefix."),
    target: z
      .string()
      .min(1)
      .describe("Vault-relative path of the NEW note, e.g. '02 Projekte/Homegrow Controller/Fix-Backlog.md'. Must not exist yet."),
  },
  handler: async ({
    source,
    section,
    target,
  }: {
    source: string;
    section: string;
    target: string;
  }) => {
    if (isProtectedRootFile(source) || isProtectedRootFile(target)) {
      return err(
        "AGENTS.md / CLAUDE.md im Vault-Root sind die Regelquelle des Servers und dürfen nicht gesplittet werden.",
      );
    }
    const srcAbs = resolveVaultPath(source);
    const dstAbs = resolveVaultPath(target);

    const raw = await readIfExists(srcAbs);
    if (raw === null) return err(`Quelle existiert nicht: ${source}`);
    if ((await readIfExists(dstAbs)) !== null) {
      return err(`Ziel existiert bereits, abgebrochen: ${target}`);
    }

    const parsed = matter(raw);
    const body = parsed.content;

    const headerRegex = new RegExp(`^## ${escapeRegex(section)}\\s*$`, "m");
    const headerMatch = body.match(headerRegex);
    if (!headerMatch || headerMatch.index === undefined) {
      return err(`Section '## ${section}' nicht gefunden in ${source}`);
    }
    const stamp = timestampBerlin();
    const sourceName = path.basename(source, ".md");
    const targetName = path.basename(target, ".md");
    await getWriter().writeMulti(
      [source],
      (raws) => {
        const fresh = raws[0];
        if (fresh == null) throw new Error(`source vanished: ${source}`);
        const { source: newSource, target: newTarget } = splitNoteContent(
          fresh,
          section,
          targetName,
          sourceName,
          stamp,
        );
        return [
          { path: source, content: newSource },
          { path: target, content: newTarget },
        ];
      },
      `split_note ${source} § ${section} -> ${target}`,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `Section '## ${section}' aus '${source}' nach '${target}' ausgelagert und per [[${targetName}]] verlinkt.`,
        },
      ],
    };
  },
};

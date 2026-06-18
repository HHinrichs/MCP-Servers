import { z } from "zod";
import { getWriter } from "../lib/writer_singleton.js";
import { createNoteContent } from "../lib/transforms.js";
import {
  VAULT_DIRS,
  readIfExists,
  safeName,
  timestampBerlin,
  todayBerlin,
  vaultPath,
} from "../lib/vault.js";

/** Derive a short filename title from the first words of the text. */
function deriveTitle(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const words = firstLine
    .replace(/[#*`>\[\]()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
  const title = safeName(words).replace(/\.md$/i, "").slice(0, 60).trim();
  return title || "Notiz";
}

export const quickDumpTool = {
  name: "quick_dump",
  description:
    "Capture a quick thought as an atomic inbox note: one file per thought at '01 Inbox/YYYY-MM-DD HHMM <Titel>.md'. Use whenever the user wants to capture an idea, snippet, link, or todo that doesn't yet have a specific place. Atomic files make later triage executable: content gets merged into its proper home via add_to_*, then the inbox file is moved to '06 Archiv/Inbox/' via move_note.",
  inputSchema: {
    text: z.string().min(1).describe("Free-form text to capture verbatim."),
    title: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("Short title for the filename. Derived from the first words of the text if omitted."),
  },
  handler: async ({ text, title }: { text: string; title?: string }) => {
    const stamp = timestampBerlin();
    const fileStamp = stamp.replace(":", ""); // YYYY-MM-DD HHMM
    const cleanTitle = title
      ? safeName(title).replace(/\.md$/i, "").slice(0, 80).trim() || deriveTitle(text)
      : deriveTitle(text);

    // Same minute + same title → numeric suffix instead of overwrite.
    let name = `${fileStamp} ${cleanTitle}.md`;
    for (let i = 2; (await readIfExists(vaultPath(VAULT_DIRS.inbox, name))) !== null; i++) {
      name = `${fileStamp} ${cleanTitle} ${i}.md`;
    }

    const rel = `${VAULT_DIRS.inbox}/${name}`;
    await getWriter().writeToOrigin(
      rel,
      () => createNoteContent({ tags: ["inbox"], erstellt: todayBerlin() }, `\n# ${cleanTitle}\n\n${text}\n`),
      `quick_dump ${name}`,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `Inbox-Notiz angelegt: 01 Inbox/${name} _(${stamp})_`,
        },
      ],
    };
  },
};

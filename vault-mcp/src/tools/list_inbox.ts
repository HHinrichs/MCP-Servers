import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { VAULT_DIRS, inboxFile, readIfExists, vaultPath } from "../lib/vault.js";

/** Files in 01 Inbox/ that are not triagable thoughts. */
function isListable(name: string): boolean {
  return name.endsWith(".md") && !name.startsWith("_") && name !== "Brain Dump.md";
}

export const listInboxTool = {
  name: "list_inbox",
  description:
    "List atomic inbox notes from 01 Inbox/ (one file per thought, 'YYYY-MM-DD HHMM <Titel>.md'), newest first, each with a content snippet. Triage flow per note: merge the content into its proper home via add_to_*, then move the note file to '06 Archiv/Inbox/' via move_note.",
  inputSchema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max entries to return. Default 50."),
  },
  handler: async ({ limit = 50 }: { limit?: number }) => {
    const dir = vaultPath(VAULT_DIRS.inbox);
    let names: string[] = [];
    try {
      names = (await fs.readdir(dir)).filter(isListable).sort().reverse();
    } catch {
      // dir missing — empty inbox
    }

    const out = names.slice(0, limit);
    const entries = await Promise.all(
      out.map(async (name) => {
        try {
          const parsed = matter(await fs.readFile(path.join(dir, name), "utf8"));
          const snippet = parsed.content.replace(/^#.*$/m, "").replace(/\s+/g, " ").trim().slice(0, 200);
          return `- **${name.replace(/\.md$/, "")}**\n  ${snippet}`;
        } catch {
          return `- **${name.replace(/\.md$/, "")}** _(nicht lesbar)_`;
        }
      }),
    );

    // Legacy: alte Eintraege, die noch im Brain Dump stecken.
    const legacy = await readIfExists(inboxFile());
    const legacyCount = legacy ? (legacy.match(/^### /gm)?.length ?? 0) : 0;
    const legacyHint =
      legacyCount > 0
        ? `\n\n_Hinweis: ${legacyCount} Alt-Eintrag/Einträge stecken noch in 'Brain Dump.md' (Vor-2026-06-13-Format) — manuell triagieren._`
        : "";

    const summary =
      entries.length === 0
        ? `Inbox ist leer.${legacyHint}`
        : `${names.length} Inbox-Notiz(en), zeige ${entries.length} (neueste zuerst):\n\n${entries.join("\n")}${legacyHint}`;

    return { content: [{ type: "text" as const, text: summary }] };
  },
};

import { z } from "zod";
import { readIfExists, inboxFile } from "../lib/vault.js";

export const listInboxTool = {
  name: "list_inbox",
  description:
    "List inbox entries from 01 Inbox/Brain Dump.md, parsed by '### YYYY-MM-DD HH:MM'-style timestamp headers. Returns the most recent first.",
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
    const content = await readIfExists(inboxFile());
    if (!content) {
      return {
        content: [{ type: "text" as const, text: "Inbox ist leer (Datei existiert nicht)." }],
      };
    }
    // Parse entries delimited by '### <header>'.
    const lines = content.split(/\r?\n/);
    const entries: Array<{ header: string; body: string }> = [];
    let currentHeader: string | null = null;
    let currentBody: string[] = [];
    const flush = () => {
      if (currentHeader !== null) {
        entries.push({ header: currentHeader, body: currentBody.join("\n").trim() });
      }
    };
    for (const line of lines) {
      const m = line.match(/^###\s+(.+?)\s*$/);
      if (m) {
        flush();
        currentHeader = m[1] ?? null;
        currentBody = [];
      } else if (currentHeader !== null) {
        currentBody.push(line);
      }
    }
    flush();

    // Newest first (assumes headers sort lex-correctly thanks to YYYY-MM-DD HH:MM).
    entries.reverse();
    const out = entries.slice(0, limit);

    const summary =
      out.length === 0
        ? "Keine `### Timestamp`-Einträge in der Inbox gefunden."
        : `${entries.length} Eintrag/Einträge insgesamt, zeige Top ${out.length}:\n\n` +
          out
            .map(
              (e, i) =>
                `${i + 1}. **${e.header}**\n   ${e.body.slice(0, 200).replace(/\s+/g, " ").trim()}`,
            )
            .join("\n\n");

    return { content: [{ type: "text" as const, text: summary }] };
  },
};

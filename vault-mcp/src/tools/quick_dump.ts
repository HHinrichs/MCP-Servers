import { z } from "zod";
import { markDirty } from "../lib/git.js";
import { appendUnderSection, inboxFile, timestampBerlin } from "../lib/vault.js";

export const quickDumpTool = {
  name: "quick_dump",
  description:
    "Append a quick thought to the inbox brain dump. Use whenever the user wants to capture an idea, snippet, link, or todo that doesn't yet have a specific place.",
  inputSchema: {
    text: z.string().min(1).describe("Free-form text to capture verbatim."),
  },
  handler: async ({ text }: { text: string }) => {
    const stamp = timestampBerlin();
    await appendUnderSection(
      inboxFile(),
      null,
      `### ${stamp}\n\n${text}\n`,
      { title: "Brain Dump", tags: ["inbox"] },
    );
    markDirty(`quick_dump @ ${stamp}`);
    return {
      content: [{ type: "text" as const, text: `Inbox-Eintrag gespeichert um ${stamp}.` }],
    };
  },
};

import { z } from "zod";
import { markDirty } from "../lib/git.js";
import { appendUnderSection, areaFile, timestampBerlin } from "../lib/vault.js";

export const addToAreaTool = {
  name: "add_to_area",
  description:
    "Append text to a section in an area file under 03 Bereiche/<area>/. Areas are ongoing responsibilities without an end date (e.g. 'Hostinger', 'Coolify'). REQUIRED WORKFLOW: call find_similar first with the new text — if it returns a hit in 03 Bereiche/ with score ≥ 0.15, target the existing area file rather than creating a new one.",
  inputSchema: {
    area: z.string().min(1).describe("Area name (matches the folder name in 03 Bereiche/)."),
    section: z.string().min(1).describe("Heading under which to append, without '##'."),
    text: z.string().min(1).describe("Markdown content to append."),
  },
  handler: async ({
    area,
    section,
    text,
  }: {
    area: string;
    section: string;
    text: string;
  }) => {
    const stamp = timestampBerlin();
    await appendUnderSection(
      areaFile(area),
      section,
      `- _(${stamp})_ ${text}\n`,
      { title: area, tags: ["bereich"] },
    );
    markDirty(`add_to_area ${area} / ${section}`);
    return {
      content: [
        { type: "text" as const, text: `Zu '${area}' → ## ${section} hinzugefügt.` },
      ],
    };
  },
};

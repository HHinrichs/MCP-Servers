import { z } from "zod";
import { dedupWarning } from "../lib/dedup.js";
import { getWriter } from "../lib/writer_singleton.js";
import { appendUnderSectionContent } from "../lib/transforms.js";
import { areaFile, noteSizeHint, relFromVault, timestampBerlin } from "../lib/vault.js";

export const addToAreaTool = {
  name: "add_to_area",
  description:
    "Append text to a section in an area file under 03 Bereiche/<area>/. Areas are ongoing responsibilities without an end date (e.g. 'Hostinger', 'Coolify'). REQUIRED WORKFLOW: call find_similar first with the new text — if it labels a hit in 03 Bereiche/ as 'verwandt' or 'sehr ähnlich', target the existing area file rather than creating a new one. The response includes a size hint and a dedup warning if a very similar entry already exists elsewhere.",
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
    const target = areaFile(area);
    await getWriter().writeToOrigin(
      relFromVault(target),
      (raw) => appendUnderSectionContent(raw, section, `- _(${stamp})_ ${text}\n`, { title: area, tags: ["bereich"] }),
      `add_to_area ${area} / ${section}`,
    );
    const hint = await noteSizeHint(target);
    const dedup = await dedupWarning(text, target);
    const body =
      `Zu '${area}' → ## ${section} hinzugefügt.` +
      (hint.message ? `\n\n${hint.message}` : "") +
      dedup;
    return { content: [{ type: "text" as const, text: body }] };
  },
};

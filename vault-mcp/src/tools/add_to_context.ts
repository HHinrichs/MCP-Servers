import { z } from "zod";
import { markDirty } from "../lib/git.js";
import { dedupWarning } from "../lib/dedup.js";
import {
  KONTEXT_FILES,
  appendUnderSection,
  kontextFile,
  noteSizeHint,
  timestampBerlin,
} from "../lib/vault.js";

export const addToContextTool = {
  name: "add_to_context",
  description:
    "Append text to a section in one of the four product-strategy files under 00 Kontext/ (Über das Produkt | Zielgruppe | Pitch | Vision). Use for sales/positioning insights, ICP details, pitch fragments, product vision. Same find_similar / size-hint discipline as add_to_project / add_to_area / add_to_resource: call find_similar first; if a meaningfully related entry already exists in 00 Kontext/ (labelled 'verwandt' or 'sehr ähnlich'), extend it instead of creating a duplicate section. The response carries a dedup warning if a very similar entry already exists elsewhere.",
  inputSchema: {
    file: z
      .enum(KONTEXT_FILES)
      .describe(
        "Which Kontext file: 'Über das Produkt' (what the product is), 'Zielgruppe' (ICP / buyer), 'Pitch' (one-liner / elevator / USPs), 'Vision' (long-term direction).",
      ),
    section: z
      .string()
      .min(1)
      .describe("Section heading under which to append, without '##'."),
    text: z.string().min(1).describe("Markdown content to append."),
  },
  handler: async ({
    file,
    section,
    text,
  }: {
    file: (typeof KONTEXT_FILES)[number];
    section: string;
    text: string;
  }) => {
    const stamp = timestampBerlin();
    const target = kontextFile(file);
    await appendUnderSection(target, section, `- _(${stamp})_ ${text}\n`, {
      title: file,
      tags: ["kontext"],
    });
    markDirty(`add_to_context ${file} / ${section}`);
    const hint = await noteSizeHint(target);
    const dedup = await dedupWarning(text, target);
    const body =
      `Zu '00 Kontext/${file}' → ## ${section} hinzugefügt.` +
      (hint.message ? `\n\n${hint.message}` : "") +
      dedup;
    return { content: [{ type: "text" as const, text: body }] };
  },
};

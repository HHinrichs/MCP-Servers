import { z } from "zod";
import { dedupWarning } from "../lib/dedup.js";
import { getWriter } from "../lib/writer_singleton.js";
import { appendUnderSectionContent } from "../lib/transforms.js";
import { noteSizeHint, relFromVault, resourceFile, timestampBerlin } from "../lib/vault.js";

export const addToResourceTool = {
  name: "add_to_resource",
  description:
    "Append a note to a resource topic under 04 Ressourcen/<topic>/. Resources are reference material on specific subjects (e.g. 'FastAPI', 'Nginx'). REQUIRED WORKFLOW: call find_similar first — if a 04 Ressourcen/ note already covers the topic (labelled 'verwandt' or 'sehr ähnlich'), extend that one. Only create a new resource folder for genuinely new topics. The response includes a size hint and a dedup warning if a very similar entry already exists elsewhere.",
  inputSchema: {
    topic: z.string().min(1).describe("Resource topic name (matches folder in 04 Ressourcen/)."),
    text: z.string().min(1).describe("Markdown content to append under '## Notizen'."),
  },
  handler: async ({ topic, text }: { topic: string; text: string }) => {
    const stamp = timestampBerlin();
    const target = resourceFile(topic);
    await getWriter().writeToOrigin(
      relFromVault(target),
      (raw) => appendUnderSectionContent(raw, "Notizen", `- _(${stamp})_ ${text}\n`, { title: topic, tags: ["ressource"] }),
      `add_to_resource ${topic}`,
    );
    const hint = await noteSizeHint(target);
    const dedup = await dedupWarning(text, target);
    const body =
      `Zu Ressource '${topic}' hinzugefügt.` +
      (hint.message ? `\n\n${hint.message}` : "") +
      dedup;
    return { content: [{ type: "text" as const, text: body }] };
  },
};

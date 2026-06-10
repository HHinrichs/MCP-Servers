import { z } from "zod";
import { markDirty } from "../lib/git.js";
import { appendUnderSection, noteSizeHint, resourceFile, timestampBerlin } from "../lib/vault.js";

export const addToResourceTool = {
  name: "add_to_resource",
  description:
    "Append a note to a resource topic under 04 Ressourcen/<topic>/. Resources are reference material on specific subjects (e.g. 'FastAPI', 'Nginx'). REQUIRED WORKFLOW: call find_similar first — if a 04 Ressourcen/ note already covers the topic (score ≥ 0.15), extend that one. Only create a new resource folder for genuinely new topics. The response includes a size hint — large resource files should be split into subtopics in the same folder.",
  inputSchema: {
    topic: z.string().min(1).describe("Resource topic name (matches folder in 04 Ressourcen/)."),
    text: z.string().min(1).describe("Markdown content to append under '## Notizen'."),
  },
  handler: async ({ topic, text }: { topic: string; text: string }) => {
    const stamp = timestampBerlin();
    const target = resourceFile(topic);
    await appendUnderSection(target, "Notizen", `- _(${stamp})_ ${text}\n`, {
      title: topic,
      tags: ["ressource"],
    });
    markDirty(`add_to_resource ${topic}`);
    const hint = await noteSizeHint(target);
    const body =
      `Zu Ressource '${topic}' hinzugefügt.` +
      (hint.message ? `\n\n${hint.message}` : "");
    return { content: [{ type: "text" as const, text: body }] };
  },
};

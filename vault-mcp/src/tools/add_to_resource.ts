import { z } from "zod";
import { markDirty } from "../lib/git.js";
import { appendUnderSection, resourceFile, timestampBerlin } from "../lib/vault.js";

export const addToResourceTool = {
  name: "add_to_resource",
  description:
    "Append a note to a resource topic under 04 Ressourcen/<topic>/. Resources are reference material on specific subjects (e.g. 'FastAPI', 'Nginx'). REQUIRED WORKFLOW: call find_similar first — if a 04 Ressourcen/ note already covers the topic (score ≥ 0.15), extend that one. Only create a new resource folder for genuinely new topics.",
  inputSchema: {
    topic: z.string().min(1).describe("Resource topic name (matches folder in 04 Ressourcen/)."),
    text: z.string().min(1).describe("Markdown content to append under '## Notizen'."),
  },
  handler: async ({ topic, text }: { topic: string; text: string }) => {
    const stamp = timestampBerlin();
    await appendUnderSection(
      resourceFile(topic),
      "Notizen",
      `- _(${stamp})_ ${text}\n`,
      { title: topic, tags: ["ressource"] },
    );
    markDirty(`add_to_resource ${topic}`);
    return {
      content: [{ type: "text" as const, text: `Zu Ressource '${topic}' hinzugefügt.` }],
    };
  },
};

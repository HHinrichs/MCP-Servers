import { z } from "zod";
import { markDirty } from "../lib/git.js";
import { appendUnderSection, noteSizeHint, projectFile, timestampBerlin } from "../lib/vault.js";

export const addToProjectTool = {
  name: "add_to_project",
  description:
    "Append text to a section in a project file under 02 Projekte/. Use for project-related notes (architecture decisions, build steps, bugs, ideas about a specific project). REQUIRED WORKFLOW: call find_similar first with the new text — if it returns a hit in 02 Projekte/ with score ≥ 0.15, point THIS tool at that existing project and pick a fitting section instead of creating a new project file. Only create a new project file when the topic is genuinely new. The response includes a size hint — if the target file is large, consider splitting before appending more.",
  inputSchema: {
    project: z
      .string()
      .min(1)
      .describe("Project name (matches the file name in 02 Projekte/, e.g. 'Homegrow Controller')."),
    section: z
      .string()
      .min(1)
      .describe("Heading under which to append, without the '##' prefix (e.g. 'Notizen', 'Offene Punkte')."),
    text: z.string().min(1).describe("Markdown content to append."),
  },
  handler: async ({
    project,
    section,
    text,
  }: {
    project: string;
    section: string;
    text: string;
  }) => {
    const stamp = timestampBerlin();
    const target = projectFile(project);
    await appendUnderSection(target, section, `- _(${stamp})_ ${text}\n`, {
      title: project,
      tags: ["projekt"],
    });
    markDirty(`add_to_project ${project} / ${section}`);
    const hint = await noteSizeHint(target);
    const body =
      `Zu '${project}' → ## ${section} hinzugefügt.` +
      (hint.message ? `\n\n${hint.message}` : "");
    return { content: [{ type: "text" as const, text: body }] };
  },
};

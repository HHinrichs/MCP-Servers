import { z } from "zod";
import { markDirty } from "../lib/git.js";
import { appendUnderSection, projectFile, timestampBerlin } from "../lib/vault.js";

export const addToProjectTool = {
  name: "add_to_project",
  description:
    "Append text to a section in a project file under 02 Projekte/. If the section doesn't exist, it is created at the end of the file. Use for project-related notes (architecture decisions, build steps, bugs, ideas about a specific project).",
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
    await appendUnderSection(
      projectFile(project),
      section,
      `- _(${stamp})_ ${text}\n`,
      { title: project, tags: ["projekt"] },
    );
    markDirty(`add_to_project ${project} / ${section}`);
    return {
      content: [
        { type: "text" as const, text: `Zu '${project}' → ## ${section} hinzugefügt.` },
      ],
    };
  },
};

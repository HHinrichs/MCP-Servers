import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { VAULT_DIRS, vaultPath } from "../lib/vault.js";

const PROJECT_SNIPPET_CHARS = 600;

export const getBriefingTool = {
  name: "get_briefing",
  description:
    "Get a short briefing on the current state of the vault: the last few daily notes plus all active projects (status: aktiv). Use this whenever Hannes asks 'Wo war ich?', 'Was ist aktuell?', 'Stand der Dinge?' or any continuity / catch-up question — call this BEFORE answering from memory.",
  inputSchema: {
    days_back: z
      .number()
      .int()
      .min(1)
      .max(7)
      .optional()
      .describe("How many recent daily notes to include. Default 3."),
  },
  handler: async ({ days_back = 3 }: { days_back?: number }) => {
    // --- Recent daily notes ---
    const dailyDir = vaultPath(VAULT_DIRS.daily);
    let dailyFiles: string[] = [];
    try {
      const entries = await fs.readdir(dailyDir);
      dailyFiles = entries
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse()
        .slice(0, days_back);
    } catch {
      // dir missing — fine
    }

    const dailies = await Promise.all(
      dailyFiles.map(async (f) => {
        try {
          const content = await fs.readFile(path.join(dailyDir, f), "utf8");
          const parsed = matter(content);
          return { name: f.replace(/\.md$/, ""), body: parsed.content.trim() };
        } catch {
          return null;
        }
      }),
    );

    // --- Active projects (status: aktiv, or no status set) ---
    const projectsDir = vaultPath(VAULT_DIRS.projekte);
    let projectFiles: string[] = [];
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      projectFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name)
        .sort();
    } catch {
      // dir missing — fine
    }

    const projects = await Promise.all(
      projectFiles.map(async (f) => {
        try {
          const content = await fs.readFile(path.join(projectsDir, f), "utf8");
          const parsed = matter(content);
          const status = String(
            (parsed.data as Record<string, unknown>).status ?? "aktiv",
          ).toLowerCase();
          if (status && status !== "aktiv" && status !== "live") return null;
          const body = parsed.content.trim();
          const snippet =
            body.length > PROJECT_SNIPPET_CHARS
              ? body.slice(0, PROJECT_SNIPPET_CHARS) + "…"
              : body;
          return { name: f.replace(/\.md$/, ""), status, snippet };
        } catch {
          return null;
        }
      }),
    );

    const activeProjects = projects.filter(
      (p): p is { name: string; status: string; snippet: string } => p !== null,
    );

    // --- Compose briefing ---
    const parts: string[] = [];

    parts.push("# Vault-Briefing\n");

    parts.push("## Aktuelle Daily Notes");
    const validDailies = dailies.filter((d): d is { name: string; body: string } => d !== null);
    if (validDailies.length === 0) {
      parts.push("\n_Keine Daily Notes vorhanden._");
    } else {
      for (const d of validDailies) {
        parts.push(`\n### ${d.name}\n\n${d.body || "_(leer)_"}`);
      }
    }

    parts.push("\n## Aktive Projekte");
    if (activeProjects.length === 0) {
      parts.push("\n_Keine Projekte mit status: aktiv gefunden._");
    } else {
      for (const p of activeProjects) {
        parts.push(`\n### [[${p.name}]] _(status: ${p.status})_\n\n${p.snippet}`);
      }
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
  },
};

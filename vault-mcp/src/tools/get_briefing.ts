import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { VAULT_DIRS, vaultPath } from "../lib/vault.js";
import { getGit } from "../lib/git.js";

const PROJECT_SNIPPET_CHARS = 600;
const DEFAULT_COMMIT_COUNT = 10;
const MAX_COMMIT_COUNT = 30;

export const getBriefingTool = {
  name: "get_briefing",
  description:
    "Get a short briefing on the current state of the vault: the last few daily notes, all active projects, AND the last N git commits (i.e. the actual recent changes). Use this whenever Hannes asks 'Wo war ich?', 'Was ist aktuell?', 'Stand der Dinge?', 'Was habe ich zuletzt bearbeitet?', or any continuity / catch-up question — call this BEFORE answering from memory.",
  inputSchema: {
    days_back: z
      .number()
      .int()
      .min(1)
      .max(7)
      .optional()
      .describe("How many recent daily notes to include. Default 3."),
    commits: z
      .number()
      .int()
      .min(1)
      .max(MAX_COMMIT_COUNT)
      .optional()
      .describe(`How many recent git commits to include. Default ${DEFAULT_COMMIT_COUNT}.`),
  },
  handler: async ({
    days_back = 3,
    commits = DEFAULT_COMMIT_COUNT,
  }: {
    days_back?: number;
    commits?: number;
  }) => {
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

    // --- Recent commits (actual vault activity) ---
    parts.push(`\n## Letzte ${commits} Commits`);
    try {
      const log = await getGit().log({ maxCount: commits });
      if (log.total === 0) {
        parts.push("\n_Noch keine Commits im Vault._");
      } else {
        const fmt = new Intl.DateTimeFormat("de-DE", {
          timeZone: "Europe/Berlin",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        for (const c of log.all) {
          const subject = c.message.split("\n")[0] ?? "";
          const when = fmt.format(new Date(c.date));
          parts.push(`- _${when}_ — ${subject}`);
        }
      }
    } catch (e) {
      parts.push(`\n_Commit-Log nicht lesbar: ${(e as Error).message}_`);
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
  },
};

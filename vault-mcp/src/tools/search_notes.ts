import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { VAULT_DIRS, VAULT_TYPES, vaultPath, walkMarkdown } from "../lib/vault.js";
import type { VaultType } from "../lib/vault.js";

const TYPE_TO_DIR: Record<Exclude<VaultType, "all">, string> = {
  inbox: VAULT_DIRS.inbox,
  projekte: VAULT_DIRS.projekte,
  bereiche: VAULT_DIRS.bereiche,
  ressourcen: VAULT_DIRS.ressourcen,
  daily: VAULT_DIRS.daily,
};

function buildSnippet(content: string, queryLower: string, contextChars = 80): string {
  const idx = content.toLowerCase().indexOf(queryLower);
  if (idx === -1) return content.slice(0, contextChars).replace(/\s+/g, " ").trim();
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(content.length, idx + queryLower.length + contextChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return prefix + content.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

export const searchNotesTool = {
  name: "search_notes",
  description:
    "Full-text search across all Markdown notes in the vault, case-insensitive. Optionally filter to a folder type (inbox, projekte, bereiche, ressourcen, daily, all).",
  inputSchema: {
    query: z.string().min(1).describe("Search string (case-insensitive substring match)."),
    type: z
      .enum(VAULT_TYPES)
      .optional()
      .describe("Restrict search to a specific folder type. Default 'all'."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max results to return. Default 25."),
  },
  handler: async ({
    query,
    type = "all",
    limit = 25,
  }: {
    query: string;
    type?: VaultType;
    limit?: number;
  }) => {
    const root = type === "all" ? "" : TYPE_TO_DIR[type];
    const files = await walkMarkdown(root);
    const queryLower = query.toLowerCase();

    type Hit = { path: string; score: number; snippet: string };
    const hits: Hit[] = [];
    const vaultRoot = vaultPath();

    for (const abs of files) {
      let content: string;
      try {
        content = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const lower = content.toLowerCase();
      let score = 0;
      let pos = 0;
      while ((pos = lower.indexOf(queryLower, pos)) !== -1) {
        score++;
        pos += queryLower.length;
      }
      if (score === 0) continue;
      hits.push({
        path: path.relative(vaultRoot, abs).replace(/\\/g, "/"),
        score,
        snippet: buildSnippet(content, queryLower),
      });
    }

    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);

    const summary =
      top.length === 0
        ? `Keine Treffer für "${query}" in ${type}.`
        : `${hits.length} Datei(en) mit Treffern, zeige Top ${top.length}:\n\n` +
          top
            .map(
              (h, i) =>
                `${i + 1}. **${h.path}** _(score ${h.score})_\n   ${h.snippet}`,
            )
            .join("\n\n");

    return {
      content: [{ type: "text" as const, text: summary }],
    };
  },
};

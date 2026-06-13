import { readIfExists, vaultPath } from "./vault.js";

/**
 * Served when the vault has no AGENTS.md (fresh clone, file renamed, …).
 * Deliberately minimal: enough for a client to operate safely and to tell
 * Hannes that the real rule file is missing.
 */
export const FALLBACK_INSTRUCTIONS = `
MCP server for Hannes Korn's Second-Brain vault (HHinrichs/Second-Brain).
WARNING: the vault's AGENTS.md (the canonical rule file in the vault root)
was not found — tell Hannes about this. Until it is restored, be conservative:
prefer quick_dump into the inbox over structured writes, call find_similar
before any add_to_* tool, never delete or overwrite content, and use absolute
dates in everything you write.
`.trim();

/**
 * The vault's AGENTS.md is the single source of truth for all behavioral
 * rules. It is read per request so edits to the file take effect without a
 * server redeploy (the vault clone updates on boot and on every push-rebase).
 */
export async function loadInstructions(
  absPath: string = vaultPath("AGENTS.md"),
): Promise<string> {
  const raw = await readIfExists(absPath);
  if (raw === null || raw.trim() === "") return FALLBACK_INSTRUCTIONS;
  return raw.trim();
}

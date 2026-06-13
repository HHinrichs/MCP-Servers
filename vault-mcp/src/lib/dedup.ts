/**
 * Dedup-assist: turns the "call find_similar before add_to_*" convention into a
 * mechanism. After an add_to_* append, we embed the new content as a query and
 * warn (advisory) if a very similar section already exists ELSEWHERE — analogous
 * to the size hints. Archive and inbox are excluded (near-duplicates expected
 * there). Never throws; a failed check just yields no warning.
 */

import path from "node:path";
import { getSemanticIndex } from "./index_singleton.js";
import { SIM } from "./semantic_index.js";
import { vaultPath } from "./vault.js";

const EXCLUDE_DIRS = ["06 Archiv/", "01 Inbox/"];

function toRel(absOrRel: string): string {
  const root = vaultPath();
  if (path.isAbsolute(absOrRel)) return path.relative(root, absOrRel).replace(/\\/g, "/");
  return absOrRel.replace(/\\/g, "/");
}

function noteName(relPath: string): string {
  return path.basename(relPath, ".md");
}

/**
 * @param text       The new content being added (used as the semantic query).
 * @param targetPath The note being appended to (abs or vault-relative) — excluded from the search.
 * @returns A warning block to append to the tool response, or "" if nothing similar exists.
 */
export async function dedupWarning(text: string, targetPath: string): Promise<string> {
  const idx = getSemanticIndex();
  if (!idx || !idx.ready) return "";
  try {
    await idx.reconcile();
    const hits = await idx.searchText(text, {
      limit: 1,
      minScore: SIM.dedup,
      excludePath: toRel(targetPath),
      excludeDirs: EXCLUDE_DIRS,
    });
    const top = hits[0];
    if (!top) return "";
    return (
      `\n\n⚠ Ähnlicher Eintrag existiert bereits: [[${noteName(top.path)}]] → ## ${top.heading} ` +
      `(_${top.label}_). Prüfe, ob du dort ergänzen statt duplizieren solltest.`
    );
  } catch (e) {
    console.error("[dedup] check failed:", e);
    return "";
  }
}

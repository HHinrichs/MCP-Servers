import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { vaultPath } from "./git.js";
export { vaultPath };

export const VAULT_DIRS = {
  kontext: "00 Kontext",
  inbox: "01 Inbox",
  projekte: "02 Projekte",
  bereiche: "03 Bereiche",
  ressourcen: "04 Ressourcen",
  daily: "05 Daily Notes",
  archiv: "06 Archiv",
  anhaenge: "07 Anhänge",
} as const;

export const VAULT_TYPES = ["all", "inbox", "projekte", "bereiche", "ressourcen", "daily"] as const;
export type VaultType = (typeof VAULT_TYPES)[number];

const KEBAB_FORBIDDEN = /[\\/:*?"<>|]/g;

export function safeName(input: string): string {
  return input.trim().replace(KEBAB_FORBIDDEN, "-");
}

export function todayBerlin(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

export function timestampBerlin(): string {
  const fmt = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  // de-DE returns "10.06.2026, 22:15" → normalize to "2026-06-10 22:15"
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function ensureDir(absPath: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
}

/**
 * Reads a Markdown file with YAML frontmatter, updates the `updated` field to today,
 * and returns serialized content + body for further manipulation. If the file is
 * missing, creates a fresh one with sane defaults.
 */
export async function readOrInitMarkdown(
  absPath: string,
  init: { title?: string; tags?: string[] } = {},
): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
  const raw = await readIfExists(absPath);
  if (raw === null) {
    return {
      frontmatter: {
        tags: init.tags ?? [],
        erstellt: todayBerlin(),
        updated: todayBerlin(),
      },
      body: init.title ? `\n# ${init.title}\n\n` : "\n",
    };
  }
  const parsed = matter(raw);
  return { frontmatter: parsed.data, body: parsed.content };
}

export async function writeMarkdown(
  absPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  await ensureDir(absPath);
  // Use minute-resolution timestamp so multiple edits on the same day
  // can be distinguished from the frontmatter alone.
  const fm = { ...frontmatter, updated: timestampBerlin() };
  const serialized = matter.stringify(body, fm);
  await fs.writeFile(absPath, serialized, "utf8");
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Root-level rule files: AGENTS.md is loaded as server instructions on every
// request, CLAUDE.md is the Claude-Code pointer to it. Moving or splitting
// either would silently strip all clients of their rules.
const PROTECTED_ROOT_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);

export function isProtectedRootFile(rel: string): boolean {
  const stack: string[] = [];
  for (const part of rel.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return PROTECTED_ROOT_FILES.has(stack.join("/"));
}

/**
 * Append a block to a Markdown file under a specific `## Section` header. If the
 * section is missing, it's appended to the end of the body. If `section` is null,
 * the block is appended to the very end.
 *
 * Section matching uses a line-anchored regex so a literal "## Notizen" appearing
 * inside a table cell or code block doesn't accidentally win. Only a real header
 * line (start of line, hash-marks, exact text) matches.
 */
export async function appendUnderSection(
  absPath: string,
  section: string | null,
  block: string,
  init: { title?: string; tags?: string[] } = {},
): Promise<void> {
  const { frontmatter, body } = await readOrInitMarkdown(absPath, init);
  const trimmedBlock = block.replace(/\s+$/, "") + "\n";

  let newBody: string;
  if (section === null) {
    newBody = body.replace(/\s+$/, "") + "\n\n" + trimmedBlock;
  } else {
    const headerRegex = new RegExp(`^## ${escapeRegex(section)}\\s*$`, "m");
    const headerMatch = body.match(headerRegex);

    if (!headerMatch || headerMatch.index === undefined) {
      // Section doesn't exist yet — append a new one at the end.
      newBody =
        body.replace(/\s+$/, "") + "\n\n## " + section + "\n\n" + trimmedBlock;
    } else {
      const sectionStart = headerMatch.index;
      const sectionHeaderEnd = sectionStart + headerMatch[0].length;
      // Find the next heading line (any level) AFTER the matched section header
      // — anchored to a line start so we don't match "## Foo" inside a table.
      const nextHeaderRegex = /^#{1,6} /m;
      const remainder = body.slice(sectionHeaderEnd);
      const nextMatch = remainder.match(nextHeaderRegex);
      const insertAt = nextMatch && nextMatch.index !== undefined
        ? sectionHeaderEnd + nextMatch.index
        : body.length;
      newBody =
        body.slice(0, insertAt).replace(/\s+$/, "") +
        "\n\n" +
        trimmedBlock +
        "\n" +
        body.slice(insertAt);
    }
  }

  await writeMarkdown(absPath, frontmatter, newBody);
}

// --- Path resolvers ---

export function inboxFile(): string {
  return vaultPath(VAULT_DIRS.inbox, "Brain Dump.md");
}

export function curationFile(): string {
  return vaultPath(VAULT_DIRS.inbox, "_kuratierung.md");
}

export function dailyFile(date: string = todayBerlin()): string {
  return vaultPath(VAULT_DIRS.daily, `${date}.md`);
}

export function projectFile(project: string): string {
  return vaultPath(VAULT_DIRS.projekte, `${safeName(project)}.md`);
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the hub note of a project, tolerating both layouts: a flat
 * `02 Projekte/<P>.md` and a folder hub `02 Projekte/<P>/<P>.md`. Prefers the
 * flat hub (the canonical convention); falls back to the folder hub if only
 * that exists; defaults to the flat path for a brand-new project (so new
 * projects are created flat, never duplicated). `projekteDir` is injectable
 * for tests.
 */
export async function resolveProjectHubFile(
  project: string,
  projekteDir: string = vaultPath(VAULT_DIRS.projekte),
): Promise<string> {
  const safe = safeName(project);
  const flat = path.join(projekteDir, `${safe}.md`);
  if (await pathExists(flat)) return flat;
  const folder = path.join(projekteDir, safe, `${safe}.md`);
  if (await pathExists(folder)) return folder;
  return flat;
}

/**
 * List all project hub notes, tolerating both layouts: flat `02 Projekte/<P>.md`
 * files and folder hubs `02 Projekte/<P>/<P>.md`. A flat hub wins over a folder
 * hub of the same name; sub-notes inside a project folder (anything but the
 * same-named hub) are ignored. Used by get_briefing so folder-based projects
 * stay visible. `projekteDir` is injectable for tests.
 */
export async function listProjectHubs(
  projekteDir: string = vaultPath(VAULT_DIRS.projekte),
): Promise<{ name: string; file: string }[]> {
  let entries;
  try {
    entries = await fs.readdir(projekteDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const hubs = new Map<string, string>(); // project name -> hub file path
  // Flat hubs first — they are canonical and win on name clashes.
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".md")) {
      hubs.set(e.name.replace(/\.md$/, ""), path.join(projekteDir, e.name));
    }
  }
  // Folder hubs (<dir>/<dir>.md) only when no flat hub of that name exists.
  for (const e of entries) {
    if (!e.isDirectory() || hubs.has(e.name)) continue;
    const folderHub = path.join(projekteDir, e.name, `${e.name}.md`);
    if (await pathExists(folderHub)) hubs.set(e.name, folderHub);
  }
  return [...hubs]
    .map(([name, file]) => ({ name, file }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function areaFile(area: string): string {
  const safe = safeName(area);
  return vaultPath(VAULT_DIRS.bereiche, safe, `${safe}.md`);
}

export function resourceFile(topic: string): string {
  const safe = safeName(topic);
  return vaultPath(VAULT_DIRS.ressourcen, safe, `${safe}.md`);
}

export const KONTEXT_FILES = ["Über das Produkt", "Zielgruppe", "Pitch", "Vision"] as const;
export type KontextFile = (typeof KONTEXT_FILES)[number];

export function kontextFile(name: KontextFile): string {
  return vaultPath(VAULT_DIRS.kontext, `${name}.md`);
}

/** Resolve a user-supplied relative path against the vault root, refusing any escape. */
export function resolveVaultPath(rel: string): string {
  const root = vaultPath();
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error(`path escapes the vault: ${rel}`);
  }
  return target;
}

/** Repo-relative POSIX path of an absolute vault path (for GitHub API addressing). */
export function relFromVault(absPath: string): string {
  return path.relative(vaultPath(), absPath).split(path.sep).join("/");
}

// --- Size awareness ---

/** Soft warning: file is getting large, watch out. */
export const SIZE_WARN_LINES = 300;
/** Hard warning: file should be split. */
export const SIZE_HARD_LINES = 600;

export interface NoteSizeHint {
  lines: number;
  level: "ok" | "warn" | "hard";
  message: string;
}

export async function noteSizeHint(absPath: string): Promise<NoteSizeHint> {
  const content = await readIfExists(absPath);
  if (content === null) return { lines: 0, level: "ok", message: "" };
  const lines = content.split(/\r?\n/).length;
  if (lines >= SIZE_HARD_LINES) {
    return {
      lines,
      level: "hard",
      message:
        `⚠ Datei ist mit ${lines} Zeilen sehr groß — bitte spalten: extrahiere ein passendes Thema in eine eigene .md (für Bereiche/Ressourcen im selben Ordner, für Projekte in einen Unterordner) und verlinke per Wikilink. Erst danach hier weiter anhängen.`,
    };
  }
  if (lines >= SIZE_WARN_LINES) {
    return {
      lines,
      level: "warn",
      message:
        `Hinweis: Datei hat ${lines} Zeilen. Wird sie mit dem nächsten Eintrag nochmal deutlich länger, lieber ein Subthema in eine separate .md auslagern.`,
    };
  }
  return { lines, level: "ok", message: "" };
}

// --- Walking the vault ---

export async function walkMarkdown(rootRel: string = ""): Promise<string[]> {
  const root = vaultPath(rootRel);
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".obsidian") continue;
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(abs);
      }
    }
  }
  await walk(root);
  return out;
}

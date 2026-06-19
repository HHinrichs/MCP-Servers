// Pure content transforms: (rawFileContent | null) -> newRawFileContent.
// No fs, no network — so the API write layer can re-apply them verbatim on a
// CAS conflict. Frontmatter `updated` is stamped here (single source of truth).
import matter from "gray-matter";
import { escapeRegex, timestampBerlin, todayBerlin } from "./vault.js";
import { SectionConflictError, SectionNotFoundError } from "./errors.js";

interface InitMeta {
  title?: string;
  tags?: string[];
}

function parseOrInit(
  raw: string | null,
  init: InitMeta,
): { frontmatter: Record<string, unknown>; body: string } {
  if (raw === null) {
    return {
      frontmatter: { tags: init.tags ?? [], erstellt: todayBerlin(), updated: todayBerlin() },
      body: init.title ? `\n# ${init.title}\n\n` : "\n",
    };
  }
  const parsed = matter(raw);
  return { frontmatter: parsed.data, body: parsed.content };
}

function serialize(frontmatter: Record<string, unknown>, body: string): string {
  const fm = { ...frontmatter, updated: timestampBerlin() };
  return matter.stringify(body, fm);
}

/** Append a block under a `## Section` (creating the section/file as needed). */
export function appendUnderSectionContent(
  raw: string | null,
  section: string | null,
  block: string,
  init: InitMeta = {},
): string {
  const { frontmatter, body } = parseOrInit(raw, init);
  const trimmedBlock = block.replace(/\s+$/, "") + "\n";

  let newBody: string;
  if (section === null) {
    newBody = body.replace(/\s+$/, "") + "\n\n" + trimmedBlock;
  } else {
    const headerRegex = new RegExp(`^## ${escapeRegex(section)}\\s*$`, "m");
    const headerMatch = body.match(headerRegex);
    if (!headerMatch || headerMatch.index === undefined) {
      newBody = body.replace(/\s+$/, "") + "\n\n## " + section + "\n\n" + trimmedBlock;
    } else {
      const sectionHeaderEnd = headerMatch.index + headerMatch[0].length;
      const remainder = body.slice(sectionHeaderEnd);
      const nextMatch = remainder.match(/^#{1,6} /m);
      const insertAt =
        nextMatch && nextMatch.index !== undefined ? sectionHeaderEnd + nextMatch.index : body.length;
      newBody =
        body.slice(0, insertAt).replace(/\s+$/, "") + "\n\n" + trimmedBlock + "\n" + body.slice(insertAt);
    }
  }
  return serialize(frontmatter, newBody);
}

/** Serialize a brand-new note from explicit frontmatter + body. */
export function createNoteContent(frontmatter: Record<string, unknown>, body: string): string {
  return serialize(frontmatter, body);
}

/** Split a `## Section` (with its `###` subsections) into a new note + stub. */
export function splitNoteContent(
  sourceRaw: string,
  section: string,
  targetName: string,
  sourceName: string,
  stamp: string,
): { source: string; target: string; extractedEmpty: boolean } {
  const parsed = matter(sourceRaw);
  const body = parsed.content;
  const headerRegex = new RegExp(`^## ${escapeRegex(section)}\\s*$`, "m");
  const headerMatch = body.match(headerRegex);
  if (!headerMatch || headerMatch.index === undefined) {
    throw new Error(`section '## ${section}' not found`);
  }
  const contentStart = headerMatch.index + headerMatch[0].length;
  const remainder = body.slice(contentStart);
  const nextMatch = remainder.match(/^#{1,2} /m);
  const contentEnd =
    nextMatch && nextMatch.index !== undefined ? contentStart + nextMatch.index : body.length;
  const extracted = body.slice(contentStart, contentEnd).trim();

  const sourceTags = Array.isArray(parsed.data.tags) ? parsed.data.tags : [];
  const target = serialize(
    { tags: sourceTags, erstellt: todayBerlin() },
    `\n# ${targetName}\n\n_(Ausgelagert aus [[${sourceName}]] am ${stamp})_\n\n${extracted}\n`,
  );
  const newBody =
    body.slice(0, contentStart).replace(/\s+$/, "") +
    `\n\n→ ausgelagert nach [[${targetName}]] _(${stamp})_\n\n` +
    body.slice(contentEnd);
  const source = serialize(parsed.data, newBody);
  return { source, target, extractedEmpty: extracted.length === 0 };
}

/** Locate a `## section` body: from after the header to the next `#`/`##` (incl. its `###`). */
function locateSection(
  body: string,
  section: string,
): { sectionStart: number; contentStart: number; contentEnd: number } {
  const headerRegex = new RegExp(`^## ${escapeRegex(section)}\\s*$`, "m");
  const headerMatch = body.match(headerRegex);
  if (!headerMatch || headerMatch.index === undefined) {
    throw new SectionNotFoundError(section);
  }
  const sectionStart = headerMatch.index;
  const contentStart = sectionStart + headerMatch[0].length;
  const remainder = body.slice(contentStart);
  const nextMatch = remainder.match(/^#{1,2} /m);
  const contentEnd =
    nextMatch && nextMatch.index !== undefined ? contentStart + nextMatch.index : body.length;
  return { sectionStart, contentStart, contentEnd };
}

/** Replace the body under `## section` after a trim-normalized expected-text guard. */
export function replaceSectionContent(
  raw: string,
  section: string,
  newContent: string,
  expectedCurrent: string,
): string {
  const parsed = matter(raw);
  const body = parsed.content;
  const { contentStart, contentEnd } = locateSection(body, section);
  const current = body.slice(contentStart, contentEnd).trim();
  if (current !== expectedCurrent.trim()) {
    throw new SectionConflictError(section, current);
  }
  const newBody =
    body.slice(0, contentStart).replace(/\s+$/, "") +
    "\n\n" +
    newContent.trim() +
    "\n\n" +
    body.slice(contentEnd);
  return serialize(parsed.data, newBody);
}

/** Remove `## section` (header + body + subsections) after a trim-normalized guard. */
export function removeSection(raw: string, section: string, expectedCurrent: string): string {
  const parsed = matter(raw);
  const body = parsed.content;
  const { sectionStart, contentStart, contentEnd } = locateSection(body, section);
  const current = body.slice(contentStart, contentEnd).trim();
  if (current !== expectedCurrent.trim()) {
    throw new SectionConflictError(section, current);
  }
  const before = body.slice(0, sectionStart).replace(/\s+$/, "");
  const after = body.slice(contentEnd).replace(/^\s+/, "");
  const newBody = before + (before && after ? "\n\n" : "") + after + (after ? "" : "\n");
  return serialize(parsed.data, newBody);
}

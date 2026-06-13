import matter from "gray-matter";
import { createHash } from "node:crypto";
import path from "node:path";

/** One indexable unit of a note: a (sub-)section with its heading and text. */
export interface SectionChunk {
  /** Vault-relative path of the source note. */
  path: string;
  /** Section heading (text after '## '), or the note title for preamble / no-section notes. */
  heading: string;
  /** The text that gets embedded (heading context + body). */
  text: string;
  /** Content-addressed hash of `text` — identical content shares a vector in the cache. */
  hash: string;
}

/**
 * Char budget per chunk. multilingual-e5-small truncates at 512 tokens; at a
 * conservative ~3.5 chars/token for mixed DE/EN that is ~1800 chars, so 1500
 * leaves headroom. Oversized '## ' sections are sub-chunked below this.
 */
export const SECTION_MAX_CHARS = 1500;

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function mkChunk(relPath: string, heading: string, body: string): SectionChunk {
  const text = `${heading}\n\n${body}`.trim();
  return { path: relPath, heading, text, hash: sha(text) };
}

/** Split an oversized body into pieces under `maxChars`, preferring paragraph breaks. */
function packParagraphs(body: string, maxChars: number): string[] {
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    // A single paragraph larger than the budget is hard-sliced.
    if (p.length > maxChars) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
      continue;
    }
    if (cur && cur.length + p.length + 2 > maxChars) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

interface RawSection {
  heading: string;
  body: string;
}

/** Split the body (frontmatter already removed) into '## ' sections + a leading preamble. */
function rawSections(body: string, titleHeading: string): RawSection[] {
  const lines = body.split(/\r?\n/);
  const sections: RawSection[] = [];
  let curHeading = titleHeading; // preamble before the first '## ' lives under the title
  let curLines: string[] = [];
  const flush = () => {
    const text = curLines.join("\n").trim();
    if (text) sections.push({ heading: curHeading, body: text });
    curLines = [];
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      curHeading = m[1] ?? titleHeading;
    } else if (/^#\s+/.test(line)) {
      // An H1 line (the note title or a second one) — skip it, never index the bare title line.
      continue;
    } else {
      curLines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Split a Markdown note into indexable chunks at '## ' granularity (### subsections
 * stay within their parent). Frontmatter and the '# title' line are stripped.
 * Oversized sections are sub-chunked under `maxChars`. A note without '## '
 * sections becomes a single chunk headed by its title.
 */
export function splitIntoChunks(
  relPath: string,
  raw: string,
  maxChars: number = SECTION_MAX_CHARS,
): SectionChunk[] {
  let body: string;
  try {
    body = matter(raw).content;
  } catch {
    body = raw; // malformed frontmatter — index the raw text rather than drop the note
  }

  // Note title from the first '# ' heading, else the filename.
  const titleMatch = body.match(/^#\s+(.+?)\s*$/m);
  const title = (titleMatch?.[1] ?? path.basename(relPath, ".md")).trim();

  const out: SectionChunk[] = [];
  for (const sec of rawSections(body, title)) {
    if (sec.body.length <= maxChars) {
      out.push(mkChunk(relPath, sec.heading, sec.body));
    } else {
      const pieces = packParagraphs(sec.body, maxChars);
      pieces.forEach((piece, i) => {
        const heading = pieces.length > 1 ? `${sec.heading} (${i + 1}/${pieces.length})` : sec.heading;
        out.push(mkChunk(relPath, heading, piece));
      });
    }
  }
  return out;
}

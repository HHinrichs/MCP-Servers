# Mutation-Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four mutation tools to the Vault-MCP — `edit_section`, `delete_section`, `delete_note` (soft), `create_note` — closing the MCP↔direct-mode parity gap while keeping append-only as the default.

**Architecture:** Pure content transforms in `lib/transforms.ts` (re-applied verbatim by the CAS write loop) carry a fail-loud expect-text guard that throws typed errors; thin tool handlers in `src/tools/` catch those errors and map them to `{isError:true}` responses. `delete_note` reuses the `move_note` mechanic (`writeMulti` with `{delete:true}`). `create_note` is a guarded `writeToOrigin` that refuses to overwrite.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod schemas, gray-matter, vitest. Spec: `docs/superpowers/specs/2026-06-19-mutation-tools-design.md`.

**Branch:** `feat/mutation-tools` (already created, spec committed).

---

## File Structure

**Create:**
- `src/lib/errors.ts` — `SectionNotFoundError`, `SectionConflictError`, `NoteExistsError`.
- `src/tools/edit_section.ts`, `src/tools/delete_section.ts`, `src/tools/delete_note.ts`, `src/tools/create_note.ts`.
- `tests/edit_section.test.ts`, `tests/delete_section.test.ts`, `tests/delete_note.test.ts`, `tests/create_note.test.ts`.

**Modify:**
- `src/lib/transforms.ts` — add `replaceSectionContent`, `removeSection`, `createNoteFromContent`.
- `tests/transforms.test.ts` — add transform tests.
- `src/tools/index.ts` — register the four new tools.

**Vault repo (`D:/VSCProjects/SecondBrain`, separate git repo):**
- `AGENTS.md` — append-only convention + routing table.
- `02 Projekte/Vault-MCP-Server.md` — tool table + limitations.

---

## Task 1: Typed errors + `replaceSectionContent` transform

**Files:**
- Create: `src/lib/errors.ts`
- Modify: `src/lib/transforms.ts`
- Test: `tests/transforms.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/transforms.test.ts` — update the import and append the describe block:

```ts
// update the existing import at the top of the file:
import {
  appendUnderSectionContent,
  createNoteContent,
  splitNoteContent,
  replaceSectionContent,
  removeSection,
  createNoteFromContent,
} from "../src/lib/transforms.js";
import {
  SectionConflictError,
  SectionNotFoundError,
} from "../src/lib/errors.js";

const SECTION_NOTE = "---\ntags: [projekt]\n---\n\n# T\n\n## Alpha\n\n- alt\n\n### Detail\n\n- d1\n\n## Beta\n\n- b1\n";

describe("replaceSectionContent", () => {
  test("replaces a section body (incl. ### subsections) up to the next ##", () => {
    const out = replaceSectionContent(SECTION_NOTE, "Alpha", "- neu", "- alt\n\n### Detail\n\n- d1");
    expect(out).toContain("- neu");
    expect(out).not.toContain("- alt");
    expect(out).not.toContain("### Detail");
    expect(out).toContain("## Alpha"); // header preserved
    expect(out).toContain("## Beta"); // neighbour untouched
    expect(out).toContain("- b1");
  });

  test("throws SectionConflictError carrying the actual block when expected mismatches", () => {
    try {
      replaceSectionContent(SECTION_NOTE, "Alpha", "- neu", "- something else");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SectionConflictError);
      expect((e as SectionConflictError).actual).toContain("- alt");
    }
  });

  test("throws SectionNotFoundError for a missing section", () => {
    expect(() => replaceSectionContent(SECTION_NOTE, "Nope", "x", "y")).toThrow(SectionNotFoundError);
  });

  test("comparison is trim-normalized", () => {
    const out = replaceSectionContent(SECTION_NOTE, "Beta", "- b2", "  - b1  \n");
    expect(out).toContain("- b2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/transforms.test.ts`
Expected: FAIL — `replaceSectionContent`/`SectionConflictError` not exported / not defined.

- [ ] **Step 3: Create `src/lib/errors.ts`**

```ts
// Typed errors thrown by mutation transforms. None of these are RefMovedError,
// so the CAS write loop aborts immediately (no retry, no write) and the tool
// handler maps them to a fail-loud {isError:true} response.

export class SectionNotFoundError extends Error {
  constructor(public readonly section: string) {
    super(`section '## ${section}' not found`);
    this.name = "SectionNotFoundError";
  }
}

export class SectionConflictError extends Error {
  constructor(
    public readonly section: string,
    public readonly actual: string,
  ) {
    super(`section '## ${section}' changed since it was read`);
    this.name = "SectionConflictError";
  }
}

export class NoteExistsError extends Error {
  constructor(public readonly path: string) {
    super(`note already exists: ${path}`);
    this.name = "NoteExistsError";
  }
}
```

- [ ] **Step 4: Add `replaceSectionContent` to `src/lib/transforms.ts`**

Add the import near the top (after the existing imports):

```ts
import { SectionConflictError, SectionNotFoundError } from "./errors.js";
```

Append at the end of the file:

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/transforms.test.ts`
Expected: PASS (all `replaceSectionContent` tests green; existing transform tests still green).

- [ ] **Step 6: Commit**

```bash
git -C D:/VSCProjects/MCP-Servers add vault-mcp/src/lib/errors.ts vault-mcp/src/lib/transforms.ts vault-mcp/tests/transforms.test.ts
git -C D:/VSCProjects/MCP-Servers commit -m "feat(transforms): replaceSectionContent with fail-loud expect-text guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `removeSection` transform

**Files:**
- Modify: `src/lib/transforms.ts`
- Test: `tests/transforms.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/transforms.test.ts` (reuses `SECTION_NOTE` from Task 1):

```ts
describe("removeSection", () => {
  test("removes header + body + subsections, leaves neighbours intact", () => {
    const out = removeSection(SECTION_NOTE, "Alpha", "- alt\n\n### Detail\n\n- d1");
    expect(out).not.toContain("## Alpha");
    expect(out).not.toContain("- alt");
    expect(out).not.toContain("### Detail");
    expect(out).toContain("## Beta");
    expect(out).toContain("- b1");
  });

  test("throws SectionConflictError on mismatch", () => {
    expect(() => removeSection(SECTION_NOTE, "Alpha", "wrong")).toThrow(SectionConflictError);
  });

  test("throws SectionNotFoundError when missing", () => {
    expect(() => removeSection(SECTION_NOTE, "Nope", "x")).toThrow(SectionNotFoundError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/transforms.test.ts`
Expected: FAIL — `removeSection` not exported.

- [ ] **Step 3: Add `removeSection` to `src/lib/transforms.ts`**

Append at the end of the file:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/transforms.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C D:/VSCProjects/MCP-Servers add vault-mcp/src/lib/transforms.ts vault-mcp/tests/transforms.test.ts
git -C D:/VSCProjects/MCP-Servers commit -m "feat(transforms): removeSection with expect-text guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `createNoteFromContent` transform

**Files:**
- Modify: `src/lib/transforms.ts`
- Test: `tests/transforms.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/transforms.test.ts`:

```ts
describe("createNoteFromContent", () => {
  test("wraps bare content with frontmatter + H1 from the title", () => {
    const out = createNoteFromContent("Hallo Welt", "Mein Titel");
    expect(out).toMatch(/^---/);
    expect(out).toContain("# Mein Titel");
    expect(out).toContain("Hallo Welt");
    expect(out).toMatch(/updated:/);
    expect(out).toMatch(/erstellt:/);
  });

  test("does not add a second H1 when content already starts with a heading", () => {
    const out = createNoteFromContent("# Eigener Titel\n\nrumpf", "Dateiname");
    expect(out).toContain("# Eigener Titel");
    expect(out).not.toContain("# Dateiname");
  });

  test("passes through content that already has its own frontmatter (re-stamps updated)", () => {
    const out = createNoteFromContent("---\ntags: [x]\n---\n\n# A\n\nb", "Ignored");
    expect(out).toContain("# A");
    expect(out).toContain("b");
    expect(out).toMatch(/tags:/);
    expect(out).not.toContain("# Ignored");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/transforms.test.ts`
Expected: FAIL — `createNoteFromContent` not exported.

- [ ] **Step 3: Add `createNoteFromContent` to `src/lib/transforms.ts`**

Append at the end of the file:

```ts
/** Build a new note from user content: pass through if it already has frontmatter,
 *  else wrap with minimal frontmatter and an H1 from the title. */
export function createNoteFromContent(content: string, title: string): string {
  if (content.startsWith("---")) {
    const parsed = matter(content);
    return serialize(parsed.data, parsed.content);
  }
  const trimmed = content.trim();
  const body = trimmed.startsWith("#") ? `\n${trimmed}\n` : `\n# ${title}\n\n${trimmed}\n`;
  return serialize({ tags: [], erstellt: todayBerlin() }, body);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/transforms.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C D:/VSCProjects/MCP-Servers add vault-mcp/src/lib/transforms.ts vault-mcp/tests/transforms.test.ts
git -C D:/VSCProjects/MCP-Servers commit -m "feat(transforms): createNoteFromContent for create_note

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `edit_section` tool

**Files:**
- Create: `src/tools/edit_section.ts`
- Test: `tests/edit_section.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/edit_section.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";

vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { editSectionTool } from "../src/tools/edit_section.js";
import { vaultPath } from "../src/lib/vault.js";

const NOTE = "---\ntags: [projekt]\nerstellt: 2026-06-01\n---\n\n# Q\n\n## Alpha\n\n- alt\n\n## Beta\n\n- b1\n";

async function makeNote(rel: string, content = NOTE): Promise<string> {
  const abs = path.join(vaultPath(), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

describe("edit_section", () => {
  test("replaces the section body when expected_current matches", async () => {
    const dir = `t-${randomUUID()}`;
    const abs = await makeNote(`${dir}/N.md`);
    const res = await editSectionTool.handler({
      file: `${dir}/N.md`, section: "Alpha", new_content: "- neu", expected_current: "- alt",
    });
    expect(res.isError).toBeUndefined();
    const out = matter(await fs.readFile(abs, "utf8"));
    expect(out.content).toContain("- neu");
    expect(out.content).not.toContain("- alt");
    expect(out.content).toContain("## Beta");
  });

  test("fail-loud on guard mismatch: no write, returns the actual block", async () => {
    const dir = `t-${randomUUID()}`;
    const abs = await makeNote(`${dir}/N.md`);
    const res = await editSectionTool.handler({
      file: `${dir}/N.md`, section: "Alpha", new_content: "- neu", expected_current: "- anders",
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("- alt");
    expect(await fs.readFile(abs, "utf8")).toBe(NOTE);
  });

  test("errors when the section is missing", async () => {
    const dir = `t-${randomUUID()}`;
    await makeNote(`${dir}/N.md`);
    const res = await editSectionTool.handler({
      file: `${dir}/N.md`, section: "Nope", new_content: "x", expected_current: "y",
    });
    expect(res.isError).toBe(true);
  });

  test("refuses protected root files", async () => {
    const res = await editSectionTool.handler({
      file: "AGENTS.md", section: "Routing", new_content: "x", expected_current: "y",
    });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/edit_section.test.ts`
Expected: FAIL — cannot find `../src/tools/edit_section.js`.

- [ ] **Step 3: Create `src/tools/edit_section.ts`**

```ts
import { z } from "zod";
import { getWriter } from "../lib/writer_singleton.js";
import { replaceSectionContent } from "../lib/transforms.js";
import { isProtectedRootFile, readIfExists, resolveVaultPath } from "../lib/vault.js";
import { SectionConflictError, SectionNotFoundError } from "../lib/errors.js";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const editSectionTool = {
  name: "edit_section",
  description:
    "Correction tool — replace the body under a '## Section' of an existing note (incl. its '###' subsections, up to the next '##'/'#'). Append remains the default; use add_to_* for new entries. FAIL-LOUD GUARD: read the section with read_note first and pass its current body as expected_current; if the section changed underneath you, the write is refused and the current content is returned so you can re-read and retry. The '## Section' header is kept; only the body below it is replaced.",
  inputSchema: {
    file: z.string().min(1).describe("Vault-relative path of the note, e.g. '00 Kontext/Pitch.md'."),
    section: z.string().min(1).describe("Heading text of the '## Section' to replace, without '##'."),
    new_content: z.string().min(1).describe("New Markdown body for the section."),
    expected_current: z
      .string()
      .min(1)
      .describe("The section's current body (from read_note). Guard: if it no longer matches, the edit is refused."),
  },
  handler: async ({
    file,
    section,
    new_content,
    expected_current,
  }: {
    file: string;
    section: string;
    new_content: string;
    expected_current: string;
  }) => {
    if (isProtectedRootFile(file)) {
      return err("AGENTS.md / CLAUDE.md im Vault-Root sind die Regelquelle des Servers und dürfen nicht editiert werden.");
    }
    if ((await readIfExists(resolveVaultPath(file))) === null) {
      return err(`Datei existiert nicht: ${file}`);
    }
    try {
      await getWriter().writeToOrigin(
        file,
        (raw) => {
          if (raw === null) throw new SectionNotFoundError(section);
          return replaceSectionContent(raw, section, new_content, expected_current);
        },
        `edit_section ${file} / ${section}`,
      );
    } catch (e) {
      if (e instanceof SectionConflictError) {
        return err(
          `Konflikt in '## ${section}' (${file}): der aktuelle Inhalt weicht von expected_current ab — nichts geschrieben.\n\nAktueller Inhalt:\n${e.actual}\n\nLies die Section neu (read_note) und wiederhole.`,
        );
      }
      if (e instanceof SectionNotFoundError) {
        return err(`Section '## ${section}' nicht gefunden in ${file}.`);
      }
      throw e;
    }
    return { content: [{ type: "text" as const, text: `'## ${section}' in '${file}' ersetzt.` }] };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/edit_section.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C D:/VSCProjects/MCP-Servers add vault-mcp/src/tools/edit_section.ts vault-mcp/tests/edit_section.test.ts
git -C D:/VSCProjects/MCP-Servers commit -m "feat(tools): edit_section

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `delete_section` tool

**Files:**
- Create: `src/tools/delete_section.ts`
- Test: `tests/delete_section.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/delete_section.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { deleteSectionTool } from "../src/tools/delete_section.js";
import { vaultPath } from "../src/lib/vault.js";

const NOTE = "---\ntags: [projekt]\n---\n\n# Q\n\n## Alpha\n\n- alt\n\n## Beta\n\n- b1\n";

async function makeNote(rel: string, content = NOTE): Promise<string> {
  const abs = path.join(vaultPath(), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

describe("delete_section", () => {
  test("removes the section when expected_current matches", async () => {
    const dir = `t-${randomUUID()}`;
    const abs = await makeNote(`${dir}/N.md`);
    const res = await deleteSectionTool.handler({
      file: `${dir}/N.md`, section: "Alpha", expected_current: "- alt",
    });
    expect(res.isError).toBeUndefined();
    const out = await fs.readFile(abs, "utf8");
    expect(out).not.toContain("## Alpha");
    expect(out).toContain("## Beta");
  });

  test("fail-loud on guard mismatch (no write)", async () => {
    const dir = `t-${randomUUID()}`;
    const abs = await makeNote(`${dir}/N.md`);
    const res = await deleteSectionTool.handler({
      file: `${dir}/N.md`, section: "Alpha", expected_current: "- anders",
    });
    expect(res.isError).toBe(true);
    expect(await fs.readFile(abs, "utf8")).toBe(NOTE);
  });

  test("errors when the section is missing", async () => {
    const dir = `t-${randomUUID()}`;
    await makeNote(`${dir}/N.md`);
    const res = await deleteSectionTool.handler({
      file: `${dir}/N.md`, section: "Nope", expected_current: "x",
    });
    expect(res.isError).toBe(true);
  });

  test("refuses protected root files", async () => {
    const res = await deleteSectionTool.handler({
      file: "CLAUDE.md", section: "X", expected_current: "y",
    });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/delete_section.test.ts`
Expected: FAIL — cannot find `../src/tools/delete_section.js`.

- [ ] **Step 3: Create `src/tools/delete_section.ts`**

```ts
import { z } from "zod";
import { getWriter } from "../lib/writer_singleton.js";
import { removeSection } from "../lib/transforms.js";
import { isProtectedRootFile, readIfExists, resolveVaultPath } from "../lib/vault.js";
import { SectionConflictError, SectionNotFoundError } from "../lib/errors.js";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const deleteSectionTool = {
  name: "delete_section",
  description:
    "Cleanup/dedup tool — remove a whole '## Section' (header + body + '###' subsections) from a note, in-place. This is in-place removal, recoverable only via git (not archived). FAIL-LOUD GUARD: read the section with read_note first and pass its current body as expected_current; on mismatch the delete is refused and the current content returned. For removing a whole note, use delete_note (soft-delete).",
  inputSchema: {
    file: z.string().min(1).describe("Vault-relative path of the note."),
    section: z.string().min(1).describe("Heading text of the '## Section' to remove, without '##'."),
    expected_current: z
      .string()
      .min(1)
      .describe("The section's current body (from read_note). Guard: if it no longer matches, the delete is refused."),
  },
  handler: async ({
    file,
    section,
    expected_current,
  }: {
    file: string;
    section: string;
    expected_current: string;
  }) => {
    if (isProtectedRootFile(file)) {
      return err("AGENTS.md / CLAUDE.md im Vault-Root sind die Regelquelle des Servers und dürfen nicht editiert werden.");
    }
    if ((await readIfExists(resolveVaultPath(file))) === null) {
      return err(`Datei existiert nicht: ${file}`);
    }
    try {
      await getWriter().writeToOrigin(
        file,
        (raw) => {
          if (raw === null) throw new SectionNotFoundError(section);
          return removeSection(raw, section, expected_current);
        },
        `delete_section ${file} / ${section}`,
      );
    } catch (e) {
      if (e instanceof SectionConflictError) {
        return err(
          `Konflikt in '## ${section}' (${file}): der aktuelle Inhalt weicht von expected_current ab — nichts gelöscht.\n\nAktueller Inhalt:\n${e.actual}\n\nLies die Section neu (read_note) und wiederhole.`,
        );
      }
      if (e instanceof SectionNotFoundError) {
        return err(`Section '## ${section}' nicht gefunden in ${file}.`);
      }
      throw e;
    }
    return { content: [{ type: "text" as const, text: `'## ${section}' aus '${file}' entfernt.` }] };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/delete_section.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C D:/VSCProjects/MCP-Servers add vault-mcp/src/tools/delete_section.ts vault-mcp/tests/delete_section.test.ts
git -C D:/VSCProjects/MCP-Servers commit -m "feat(tools): delete_section

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `delete_note` tool (soft-delete)

**Files:**
- Create: `src/tools/delete_note.ts`
- Test: `tests/delete_note.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/delete_note.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { deleteNoteTool } from "../src/tools/delete_note.js";
import { vaultPath } from "../src/lib/vault.js";

async function makeNote(rel: string, content = "# Note\n"): Promise<string> {
  const abs = path.join(vaultPath(), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

describe("delete_note", () => {
  test("soft-deletes: moves to 06 Archiv/ preserving structure, original gone", async () => {
    const dir = `t-${randomUUID()}`;
    const srcAbs = await makeNote(`${dir}/N.md`);
    const res = await deleteNoteTool.handler({ path: `${dir}/N.md` });
    expect(res.isError).toBeUndefined();
    await expect(fs.access(path.join(vaultPath(), "06 Archiv", dir, "N.md"))).resolves.toBeUndefined();
    await expect(fs.access(srcAbs)).rejects.toThrow();
  });

  test("adds a timestamp suffix if the archive target already exists", async () => {
    const dir = `t-${randomUUID()}`;
    await makeNote(`${dir}/N.md`);
    await makeNote(`06 Archiv/${dir}/N.md`, "# alt\n");
    const res = await deleteNoteTool.handler({ path: `${dir}/N.md` });
    expect(res.isError).toBeUndefined();
    // original archive file untouched, a second (suffixed) file now exists
    const archiveDir = path.join(vaultPath(), "06 Archiv", dir);
    const entries = await fs.readdir(archiveDir);
    expect(entries.length).toBe(2);
  });

  test("errors when the note is missing", async () => {
    const dir = `t-${randomUUID()}`;
    const res = await deleteNoteTool.handler({ path: `${dir}/missing.md` });
    expect(res.isError).toBe(true);
  });

  test("refuses protected root files", async () => {
    await makeNote("AGENTS.md", "# Regeln\n");
    const res = await deleteNoteTool.handler({ path: "AGENTS.md" });
    expect(res.isError).toBe(true);
    await expect(fs.access(path.join(vaultPath(), "AGENTS.md"))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/delete_note.test.ts`
Expected: FAIL — cannot find `../src/tools/delete_note.js`.

- [ ] **Step 3: Create `src/tools/delete_note.ts`**

```ts
import { z } from "zod";
import { getWriter } from "../lib/writer_singleton.js";
import { isProtectedRootFile, readIfExists, resolveVaultPath, timestampBerlin } from "../lib/vault.js";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const deleteNoteTool = {
  name: "delete_note",
  description:
    "Soft-delete a whole note: move it to '06 Archiv/<original path>' instead of erasing it (always recoverable as a moved file, plus git). The folder structure is preserved; if the archive target already exists, a timestamp suffix is added. AGENTS.md / CLAUDE.md are protected. To remove just a section within a note, use delete_section.",
  inputSchema: {
    path: z.string().min(1).describe("Vault-relative path of the note to soft-delete."),
  },
  handler: async ({ path: from }: { path: string }) => {
    if (isProtectedRootFile(from)) {
      return err("AGENTS.md / CLAUDE.md im Vault-Root sind die Regelquelle des Servers und dürfen nicht gelöscht werden.");
    }
    if ((await readIfExists(resolveVaultPath(from))) === null) {
      return err(`Notiz existiert nicht: ${from}`);
    }
    const relPosix = from.split(/[\\/]/).join("/").replace(/^(\.\/)+/, "");
    let archiveRel = `06 Archiv/${relPosix}`;
    if ((await readIfExists(resolveVaultPath(archiveRel))) !== null) {
      const stamp = timestampBerlin().replace(/[: ]/g, "-");
      archiveRel = archiveRel.replace(/\.md$/, `_${stamp}.md`);
    }
    await getWriter().writeMulti(
      [from],
      (raws) => {
        const content = raws[0];
        if (content == null) throw new Error(`source vanished: ${from}`);
        return [
          { path: from, delete: true },
          { path: archiveRel, content },
        ];
      },
      `delete_note ${from} -> ${archiveRel}`,
    );
    return { content: [{ type: "text" as const, text: `Soft-deleted: ${from} → ${archiveRel}` }] };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/delete_note.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C D:/VSCProjects/MCP-Servers add vault-mcp/src/tools/delete_note.ts vault-mcp/tests/delete_note.test.ts
git -C D:/VSCProjects/MCP-Servers commit -m "feat(tools): delete_note (soft-delete to 06 Archiv)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `create_note` tool

**Files:**
- Create: `src/tools/create_note.ts`
- Test: `tests/create_note.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/create_note.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";

vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { createNoteTool } from "../src/tools/create_note.js";
import { vaultPath } from "../src/lib/vault.js";

describe("create_note", () => {
  test("creates a new note, wrapping bare content with frontmatter + H1", async () => {
    const dir = `t-${randomUUID()}`;
    const res = await createNoteTool.handler({ path: `${dir}/Neu.md`, content: "Inhalt hier" });
    expect(res.isError).toBeUndefined();
    const out = matter(await fs.readFile(path.join(vaultPath(), dir, "Neu.md"), "utf8"));
    expect(out.content).toContain("# Neu");
    expect(out.content).toContain("Inhalt hier");
    expect(out.data).toHaveProperty("erstellt");
  });

  test("refuses to overwrite an existing note", async () => {
    const dir = `t-${randomUUID()}`;
    const abs = path.join(vaultPath(), dir, "Da.md");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "# schon da\n", "utf8");
    const res = await createNoteTool.handler({ path: `${dir}/Da.md`, content: "neu" });
    expect(res.isError).toBe(true);
    expect(await fs.readFile(abs, "utf8")).toBe("# schon da\n");
  });

  test("refuses protected root files", async () => {
    const res = await createNoteTool.handler({ path: "AGENTS.md", content: "x" });
    expect(res.isError).toBe(true);
  });

  test("refuses a path that escapes the vault", async () => {
    const res = await createNoteTool.handler({ path: "../escape.md", content: "x" });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/create_note.test.ts`
Expected: FAIL — cannot find `../src/tools/create_note.js`.

- [ ] **Step 3: Create `src/tools/create_note.ts`**

```ts
import { z } from "zod";
import path from "node:path";
import { getWriter } from "../lib/writer_singleton.js";
import { createNoteFromContent } from "../lib/transforms.js";
import { isProtectedRootFile, readIfExists, resolveVaultPath } from "../lib/vault.js";
import { NoteExistsError } from "../lib/errors.js";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const createNoteTool = {
  name: "create_note",
  description:
    "Create a NEW standalone note at an arbitrary vault path — e.g. a marketing asset in '00 Kontext/', which add_to_context (curated to the 4 strategy files) cannot do. Refuses to overwrite an existing file; use edit_section or add_to_* for existing notes. Minimal frontmatter (tags, erstellt, updated) + an H1 from the filename are added automatically unless your content already starts with a '---' frontmatter block. For routed appends, prefer add_to_project/area/resource/context.",
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe("Vault-relative path of the NEW note, must end in .md and not exist yet, e.g. '00 Kontext/Marketing-Video-Skript.md'."),
    content: z.string().min(1).describe("Markdown content for the note."),
  },
  handler: async ({ path: rel, content }: { path: string; content: string }) => {
    if (isProtectedRootFile(rel)) {
      return err("AGENTS.md / CLAUDE.md im Vault-Root sind die Regelquelle des Servers und dürfen nicht überschrieben werden.");
    }
    let abs: string;
    try {
      abs = resolveVaultPath(rel);
    } catch {
      return err(`Pfad verlässt das Vault, abgebrochen: ${rel}`);
    }
    if ((await readIfExists(abs)) !== null) {
      return err(`Existiert schon: ${rel}. Nutze edit_section oder add_to_* für bestehende Notizen.`);
    }
    const title = path.basename(rel, ".md");
    try {
      await getWriter().writeToOrigin(
        rel,
        (raw) => {
          if (raw !== null) throw new NoteExistsError(rel);
          return createNoteFromContent(content, title);
        },
        `create_note ${rel}`,
      );
    } catch (e) {
      if (e instanceof NoteExistsError) {
        return err(`Existiert schon: ${rel}. Nutze edit_section oder add_to_*.`);
      }
      throw e;
    }
    return { content: [{ type: "text" as const, text: `Neue Notiz angelegt: ${rel}` }] };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/create_note.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C D:/VSCProjects/MCP-Servers add vault-mcp/src/tools/create_note.ts vault-mcp/tests/create_note.test.ts
git -C D:/VSCProjects/MCP-Servers commit -m "feat(tools): create_note (refuse-overwrite)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Register tools + full green + typecheck + build

**Files:**
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Register the four tools in `src/tools/index.ts`**

Add imports after the existing tool imports (after the `getBriefingTool` import):

```ts
import { editSectionTool } from "./edit_section.js";
import { deleteSectionTool } from "./delete_section.js";
import { deleteNoteTool } from "./delete_note.js";
import { createNoteTool } from "./create_note.js";
```

Add to the `ALL_TOOLS` array (after `getBriefingTool,`):

```ts
  editSectionTool,
  deleteSectionTool,
  deleteNoteTool,
  createNoteTool,
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — all suites green (existing + 4 new tool suites + extended transforms).

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: no errors. The `[tools] registered 18 tools` count is now correct (verify by reading `tools/index.ts` — `ALL_TOOLS` has 18 entries).

- [ ] **Step 4: Commit**

```bash
git -C D:/VSCProjects/MCP-Servers add vault-mcp/src/tools/index.ts
git -C D:/VSCProjects/MCP-Servers commit -m "feat(tools): register edit_section, delete_section, delete_note, create_note

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Update Vault `AGENTS.md` (vault repo)

**Files:**
- Modify: `D:/VSCProjects/SecondBrain/AGENTS.md`

> This is the **vault repo** (separate from the MCP repo). Per vault rules: commit directly to `main`, `git pull` first.

- [ ] **Step 1: Update the "Zwei Arbeitsmodi" → MCP-Modus bullet**

In the MCP-Modus bullet, after the sentence about tools, add that mutation is now possible:

> Ergänzen: „Seit 2026-06-19 kann der MCP-Modus auch korrigieren/löschen/anlegen: `edit_section`/`delete_section` (mit Pflicht-Guard `expected_current`, fail-loud), `delete_note` (Soft-Delete nach `06 Archiv/`) und `create_note` (neue Standalone-Notiz, refuse-overwrite). Append über `add_to_*` bleibt der Default."

- [ ] **Step 2: Update the "Konventionen → Default ist Append-only" paragraph**

Extend the "Erlaubt sind" list to note these are now MCP-Tools too:

> „… und **klare, verifizierte Korrekturen** (im MCP-Modus via `edit_section`; Section entfernen via `delete_section`; ganze Notiz soft-löschen via `delete_note` → `06 Archiv/`; neue Datei via `create_note`). Echte Ambiguität, Überschreiben von Bestehendem ohne Guard und Umstrukturierungen bleiben rückfragepflichtig."

- [ ] **Step 3: Add `create_note` to the Routing table**

Add a row to the routing table:

```markdown
| Neue Standalone-Notiz an beliebigem Pfad (Asset, Sonderfall) | `create_note`     | `<pfad>.md` (refuse-overwrite) |
```

- [ ] **Step 4: Commit + push (vault rule: direct to main)**

```bash
git -C D:/VSCProjects/SecondBrain pull --ff-only
git -C D:/VSCProjects/SecondBrain add AGENTS.md
git -C D:/VSCProjects/SecondBrain commit -m "AGENTS.md: MCP-Modus kann jetzt edit/delete/create (Mutations-Tools)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git -C D:/VSCProjects/SecondBrain push origin main
```

---

## Task 10: Update `Vault-MCP-Server` note (vault repo)

**Files:**
- Modify: `D:/VSCProjects/SecondBrain/02 Projekte/Vault-MCP-Server.md`

- [ ] **Step 1: Update the Tools table + count**

Change the `## Tools (14)` heading to `## Tools (18)` and add four rows to the table:

```markdown
| `edit_section` | `file, section, new_content, expected_current` | Ersetzt den Body unter `## section` (inkl. `###`). Fail-loud Expect-Text-Guard. _(seit 2026-06-19)_ |
| `delete_section` | `file, section, expected_current` | Entfernt `## section` in-place. Guard wie `edit_section`; nur git als Netz. _(seit 2026-06-19)_ |
| `delete_note` | `path` | Soft-Delete nach `06 Archiv/<path>` (Struktur erhalten, Clash→Zeitstempel). _(seit 2026-06-19)_ |
| `create_note` | `path, content` | Neue Standalone-Notiz an beliebigem Pfad; refuse-overwrite; Frontmatter-Auto-Wrap. _(seit 2026-06-19)_ |
```

- [ ] **Step 2: Update "Bekannte Limitierungen"**

Replace the "Kein `edit_section` / `delete_section`" bullet with:

```markdown
- **Mutation seit 2026-06-19**: `edit_section`/`delete_section` (Pflicht-Guard `expected_current`, fail-loud), `delete_note` (soft → `06 Archiv/`), `create_note` (refuse-overwrite). Append-only bleibt Default; ein generisches „beliebige Datei hart überschreiben/löschen" gibt es bewusst weiterhin nicht. Siehe [[2026-06-19]].
```

- [ ] **Step 3: Commit + push**

```bash
git -C D:/VSCProjects/SecondBrain add "02 Projekte/Vault-MCP-Server.md"
git -C D:/VSCProjects/SecondBrain commit -m "Vault-MCP-Server: Mutations-Tools dokumentiert (14->18 Tools)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git -C D:/VSCProjects/SecondBrain push origin main
```

---

## Task 11: Rollout (push, merge, redeploy, live smoke)

- [ ] **Step 1: Push the MCP feature branch**

```bash
git -C D:/VSCProjects/MCP-Servers push -u origin feat/mutation-tools
```

- [ ] **Step 2: Merge to main**

Open a PR `feat/mutation-tools → main` on GitHub and merge (matches how `feat/api-writes` landed via PR #1), **or** fast-forward locally if Hannes prefers:

```bash
git -C D:/VSCProjects/MCP-Servers checkout main && git -C D:/VSCProjects/MCP-Servers merge --ff-only feat/mutation-tools && git -C D:/VSCProjects/MCP-Servers push origin main
```

- [ ] **Step 3: Redeploy (manual — Coolify does not poll public repos)**

Coolify-UI → App `vault-mcp` → **Deploy**. Wait for healthy.

- [ ] **Step 4: Live smoke test against a throwaway note**

In a fresh MCP client session (so the new tools are registered):
1. `create_note` `06 Archiv/_smoke-2026-06-19.md` with body "test".
2. `edit_section` on it (Guard-OK), then again with a wrong `expected_current` (expect fail-loud conflict + current block).
3. `delete_section` a section (Guard-OK).
4. `delete_note` it → confirm it lands under `06 Archiv/06 Archiv/...` (or just delete the smoke file via a normal `move_note`/manual cleanup afterwards).

Confirm `claude mcp list | grep vault` shows the tools and `/healthz` is `{status:"ok"}`.

---

## Self-Review Notes (filled by plan author)

- **Spec coverage:** all four tools (Tasks 4-7), shared safety model (guard in transform Task 1/2, soft-delete Task 6, refuse-overwrite Task 7, protected-root in every tool task, path-escape Task 7), transforms (Tasks 1-3), docs (Tasks 9-10), rollout (Task 11) — covered.
- **Type consistency:** `replaceSectionContent(raw, section, newContent, expectedCurrent)`, `removeSection(raw, section, expectedCurrent)`, `createNoteFromContent(content, title)`, errors `SectionNotFoundError(section)` / `SectionConflictError(section, actual)` / `NoteExistsError(path)` — names used identically across transform + tool + test tasks.
- **No placeholders:** every code/test step shows full content; every run step has an exact command + expected result.

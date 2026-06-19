import { describe, expect, test } from "vitest";
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

describe("appendUnderSectionContent", () => {
  test("creates a fresh note when raw is null", () => {
    const out = appendUnderSectionContent(null, "Notizen", "- hallo", {
      title: "Test",
      tags: ["projekt"],
    });
    expect(out).toContain("# Test");
    expect(out).toContain("## Notizen");
    expect(out).toContain("- hallo");
    expect(out).toMatch(/updated:/);
  });

  test("appends under an existing section, before the next heading", () => {
    const raw = "---\ntags: []\n---\n\n# T\n\n## A\n\nalt\n\n## B\n\nb\n";
    const out = appendUnderSectionContent(raw, "A", "- neu");
    // "- neu" lands inside A, before "## B"
    expect(out.indexOf("- neu")).toBeGreaterThan(out.indexOf("## A"));
    expect(out.indexOf("- neu")).toBeLessThan(out.indexOf("## B"));
  });

  test("re-applying on already-appended content is additive (CAS-retry safe)", () => {
    const raw = "---\ntags: []\n---\n\n# T\n\n## A\n\nalt\n";
    const once = appendUnderSectionContent(raw, "A", "- x");
    const twice = appendUnderSectionContent(once, "A", "- x");
    expect((twice.match(/- x/g) ?? []).length).toBe(2); // each apply adds one
  });
});

describe("createNoteContent", () => {
  test("serializes frontmatter + body with an updated timestamp", () => {
    const out = createNoteContent({ tags: ["inbox"], erstellt: "2026-06-17" }, "\n# Titel\n\nrumpf\n");
    expect(out).toContain("# Titel");
    expect(out).toContain("rumpf");
    expect(out).toMatch(/updated:/);
  });
});

describe("splitNoteContent", () => {
  test("extracts a section into target and leaves a stub in source", () => {
    const raw = "---\ntags: [projekt]\n---\n\n# Hub\n\n## Keep\n\nk\n\n## Move\n\nm-body\n";
    const { source, target } = splitNoteContent(raw, "Move", "Sub", "Hub", "2026-06-17 12:00");
    expect(target).toContain("# Sub");
    expect(target).toContain("m-body");
    expect(target).toContain("[[Hub]]");
    expect(source).toContain("ausgelagert nach [[Sub]]");
    expect(source).not.toContain("m-body");
    expect(source).toContain("## Keep");
  });
});

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

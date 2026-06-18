import { describe, expect, test } from "vitest";
import {
  appendUnderSectionContent,
  createNoteContent,
  splitNoteContent,
} from "../src/lib/transforms.js";

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

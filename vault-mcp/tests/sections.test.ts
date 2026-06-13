import { describe, expect, test } from "vitest";
import { splitIntoChunks } from "../src/lib/sections.js";

const NOTE = [
  "---",
  "tags: [projekt]",
  "updated: '2026-06-13 10:00'",
  "---",
  "",
  "# Homegrow Controller",
  "",
  "Kurzer Einleitungsabsatz vor der ersten Section.",
  "",
  "## Architektur",
  "",
  "Tick-basierter Loop auf dem Raspberry Pi.",
  "",
  "### Details",
  "",
  "GPIO-Pins steuern die Pumpen.",
  "",
  "## Deployment",
  "",
  "Signierte TARs landen auf dem Nginx-Server.",
  "",
].join("\n");

describe("splitIntoChunks", () => {
  test("splits into section chunks, strips frontmatter, keeps headings", () => {
    const chunks = splitIntoChunks("02 Projekte/Homegrow Controller.md", NOTE);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain("Architektur");
    expect(headings).toContain("Deployment");
    // frontmatter never appears in any chunk text
    expect(chunks.every((c) => !c.text.includes("tags:"))).toBe(true);
    expect(chunks.every((c) => !c.text.includes("updated:"))).toBe(true);
  });

  test("### subsections stay inside their ## chunk", () => {
    const chunks = splitIntoChunks("x.md", NOTE);
    const arch = chunks.find((c) => c.heading === "Architektur");
    expect(arch).toBeDefined();
    expect(arch!.text).toContain("Tick-basierter Loop");
    expect(arch!.text).toContain("GPIO-Pins"); // the ### Details content
  });

  test("preamble before the first ## becomes a chunk under the note title", () => {
    const chunks = splitIntoChunks("x.md", NOTE);
    const pre = chunks.find((c) => c.text.includes("Einleitungsabsatz"));
    expect(pre).toBeDefined();
    expect(pre!.heading).toBe("Homegrow Controller");
  });

  test("note without ## sections yields one chunk with the title as heading", () => {
    const raw = "---\ntags: []\n---\n\n# Nur Titel\n\nEin einziger Absatz Inhalt.\n";
    const chunks = splitIntoChunks("01 Inbox/2026-06-13 1200 Idee.md", raw);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("Nur Titel");
    expect(chunks[0]!.text).toContain("Ein einziger Absatz");
  });

  test("oversized section is sub-chunked under a char budget", () => {
    const big =
      "# T\n\n## Groß\n\n" +
      Array.from({ length: 40 }, (_, i) => `Absatz ${i} mit etwas Fülltext hier drin.`).join("\n\n") +
      "\n";
    const chunks = splitIntoChunks("x.md", big, 300);
    const grossChunks = chunks.filter((c) => c.heading.startsWith("Groß"));
    expect(grossChunks.length).toBeGreaterThan(1);
    expect(grossChunks.every((c) => c.text.length <= 300 * 1.5)).toBe(true);
  });

  test("hash is content-addressed: identical text in different files shares a hash", () => {
    const a = splitIntoChunks("a.md", "# T\n\n## S\n\nGleicher Inhalt.\n");
    const b = splitIntoChunks("b.md", "# T\n\n## S\n\nGleicher Inhalt.\n");
    const sa = a.find((c) => c.heading === "S")!;
    const sb = b.find((c) => c.heading === "S")!;
    expect(sa.hash).toBe(sb.hash);
  });

  test("hash changes when content changes", () => {
    const a = splitIntoChunks("a.md", "# T\n\n## S\n\nInhalt eins.\n");
    const b = splitIntoChunks("a.md", "# T\n\n## S\n\nInhalt zwei.\n");
    expect(a.find((c) => c.heading === "S")!.hash).not.toBe(
      b.find((c) => c.heading === "S")!.hash,
    );
  });

  test("empty / frontmatter-only note yields no chunks", () => {
    expect(splitIntoChunks("x.md", "---\ntags: []\n---\n")).toHaveLength(0);
    expect(splitIntoChunks("x.md", "   \n\n")).toHaveLength(0);
  });
});

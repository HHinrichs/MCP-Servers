import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import {
  appendUnderSection,
  listProjectHubs,
  noteSizeHint,
  resolveProjectHubFile,
  resolveVaultPath,
  safeName,
  vaultPath,
} from "../src/lib/vault.js";

/** Fresh temp dir per test so tests never interfere with each other. */
async function tmpFile(name = "note.md"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
  return path.join(dir, name);
}

describe("appendUnderSection", () => {
  test("creates missing file with frontmatter, title and new section", async () => {
    const file = await tmpFile();
    await appendUnderSection(file, "Notizen", "- erster Eintrag\n", {
      title: "Neues Projekt",
      tags: ["projekt"],
    });
    const raw = await fs.readFile(file, "utf8");
    const parsed = matter(raw);
    expect(parsed.data.tags).toEqual(["projekt"]);
    expect(parsed.data.erstellt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.data.updated).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(parsed.content).toContain("# Neues Projekt");
    expect(parsed.content).toContain("## Notizen");
    expect(parsed.content).toContain("- erster Eintrag");
  });

  test("appends under existing section, before the next header", async () => {
    const file = await tmpFile();
    await fs.writeFile(
      file,
      "---\ntags: []\n---\n\n# T\n\n## Alpha\n\n- alt\n\n## Beta\n\n- beta-inhalt\n",
      "utf8",
    );
    await appendUnderSection(file, "Alpha", "- neu\n");
    const body = matter(await fs.readFile(file, "utf8")).content;
    const alphaIdx = body.indexOf("- neu");
    const betaIdx = body.indexOf("## Beta");
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(betaIdx);
  });

  test("creates the section at the end when it does not exist", async () => {
    const file = await tmpFile();
    await fs.writeFile(file, "---\ntags: []\n---\n\n# T\n\n## Alpha\n\n- alt\n", "utf8");
    await appendUnderSection(file, "Gamma", "- neu\n");
    const body = matter(await fs.readFile(file, "utf8")).content;
    expect(body.indexOf("## Gamma")).toBeGreaterThan(body.indexOf("## Alpha"));
    expect(body.indexOf("- neu")).toBeGreaterThan(body.indexOf("## Gamma"));
  });

  test("section=null appends to the very end", async () => {
    const file = await tmpFile();
    await fs.writeFile(file, "---\ntags: []\n---\n\n# T\n\n## Alpha\n\n- alt\n", "utf8");
    await appendUnderSection(file, null, "### 2026-06-13 10:00\n\nfreier eintrag\n");
    const body = matter(await fs.readFile(file, "utf8")).content;
    expect(body.trimEnd().endsWith("freier eintrag")).toBe(true);
  });

  test("does not match section text inside a table cell", async () => {
    const file = await tmpFile();
    await fs.writeFile(
      file,
      "---\ntags: []\n---\n\n# T\n\n| Spalte |\n|---|\n| ## Notizen |\n\n## Notizen\n\n- alt\n",
      "utf8",
    );
    await appendUnderSection(file, "Notizen", "- neu\n");
    const body = matter(await fs.readFile(file, "utf8")).content;
    // The new entry must land under the real header, i.e. after the table.
    expect(body.indexOf("- neu")).toBeGreaterThan(body.indexOf("\n## Notizen"));
  });

  test("section names with regex metacharacters are matched literally", async () => {
    const file = await tmpFile();
    await fs.writeFile(
      file,
      "---\ntags: []\n---\n\n# T\n\n## C++ (Tipps)\n\n- alt\n\n## Ende\n\n-\n",
      "utf8",
    );
    await appendUnderSection(file, "C++ (Tipps)", "- neu\n");
    const body = matter(await fs.readFile(file, "utf8")).content;
    expect(body.indexOf("- neu")).toBeLessThan(body.indexOf("## Ende"));
  });
});

describe("resolveVaultPath", () => {
  test("resolves a relative path inside the vault root", () => {
    const abs = resolveVaultPath("02 Projekte/Test.md");
    expect(abs).toBe(path.join(vaultPath(), "02 Projekte", "Test.md"));
  });

  test("rejects paths escaping the vault via ..", () => {
    expect(() => resolveVaultPath("../outside.md")).toThrow(/escapes the vault/);
  });
});

describe("noteSizeHint", () => {
  test("missing file is ok", async () => {
    const hint = await noteSizeHint(path.join(os.tmpdir(), "does-not-exist.md"));
    expect(hint.level).toBe("ok");
    expect(hint.lines).toBe(0);
  });

  test("levels switch at 300 (warn) and 600 (hard) lines", async () => {
    const file = await tmpFile();
    await fs.writeFile(file, Array(299).fill("x").join("\n"), "utf8");
    expect((await noteSizeHint(file)).level).toBe("ok");
    await fs.writeFile(file, Array(300).fill("x").join("\n"), "utf8");
    expect((await noteSizeHint(file)).level).toBe("warn");
    await fs.writeFile(file, Array(600).fill("x").join("\n"), "utf8");
    expect((await noteSizeHint(file)).level).toBe("hard");
  });
});

describe("safeName", () => {
  test("replaces filesystem-forbidden characters", () => {
    expect(safeName('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
  });

  test("trims surrounding whitespace", () => {
    expect(safeName("  Homegrow Controller  ")).toBe("Homegrow Controller");
  });
});

/** Fresh temp "02 Projekte"-style dir per test. */
async function tmpProjekteDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vault-projekte-"));
}

describe("resolveProjectHubFile", () => {
  test("returns the flat hub path when '<P>.md' exists", async () => {
    const dir = await tmpProjekteDir();
    await fs.writeFile(path.join(dir, "Homegrow Controller.md"), "x", "utf8");
    const hub = await resolveProjectHubFile("Homegrow Controller", dir);
    expect(hub).toBe(path.join(dir, "Homegrow Controller.md"));
  });

  test("falls back to the folder hub '<P>/<P>.md' when no flat hub exists", async () => {
    const dir = await tmpProjekteDir();
    await fs.mkdir(path.join(dir, "Vault-MCP-Server"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "Vault-MCP-Server", "Vault-MCP-Server.md"),
      "x",
      "utf8",
    );
    const hub = await resolveProjectHubFile("Vault-MCP-Server", dir);
    expect(hub).toBe(path.join(dir, "Vault-MCP-Server", "Vault-MCP-Server.md"));
  });

  test("prefers the flat hub when both flat and folder hubs exist", async () => {
    const dir = await tmpProjekteDir();
    await fs.writeFile(path.join(dir, "P.md"), "flat", "utf8");
    await fs.mkdir(path.join(dir, "P"), { recursive: true });
    await fs.writeFile(path.join(dir, "P", "P.md"), "folder", "utf8");
    const hub = await resolveProjectHubFile("P", dir);
    expect(hub).toBe(path.join(dir, "P.md"));
  });

  test("defaults to the flat path for a brand-new project (neither exists)", async () => {
    const dir = await tmpProjekteDir();
    const hub = await resolveProjectHubFile("Neu", dir);
    expect(hub).toBe(path.join(dir, "Neu.md"));
  });
});

describe("listProjectHubs", () => {
  test("lists a flat hub and ignores sub-notes in its sibling folder", async () => {
    const dir = await tmpProjekteDir();
    await fs.writeFile(path.join(dir, "Homegrow Controller.md"), "x", "utf8");
    await fs.mkdir(path.join(dir, "Homegrow Controller"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "Homegrow Controller", "Architektur.md"),
      "x",
      "utf8",
    );
    const hubs = await listProjectHubs(dir);
    expect(hubs).toEqual([
      { name: "Homegrow Controller", file: path.join(dir, "Homegrow Controller.md") },
    ]);
  });

  test("includes a folder hub '<P>/<P>.md' that has no flat counterpart", async () => {
    const dir = await tmpProjekteDir();
    await fs.mkdir(path.join(dir, "Vault-MCP-Server"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "Vault-MCP-Server", "Vault-MCP-Server.md"),
      "x",
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "Vault-MCP-Server", "Vault-MCP-Server-Testplan.md"),
      "x",
      "utf8",
    );
    const hubs = await listProjectHubs(dir);
    expect(hubs).toEqual([
      {
        name: "Vault-MCP-Server",
        file: path.join(dir, "Vault-MCP-Server", "Vault-MCP-Server.md"),
      },
    ]);
  });

  test("prefers the flat hub over a folder hub of the same name", async () => {
    const dir = await tmpProjekteDir();
    await fs.writeFile(path.join(dir, "P.md"), "flat", "utf8");
    await fs.mkdir(path.join(dir, "P"), { recursive: true });
    await fs.writeFile(path.join(dir, "P", "P.md"), "folder", "utf8");
    const hubs = await listProjectHubs(dir);
    expect(hubs).toEqual([{ name: "P", file: path.join(dir, "P.md") }]);
  });

  test("returns empty for a missing projects dir", async () => {
    const hubs = await listProjectHubs(
      path.join(os.tmpdir(), "vault-projekte-does-not-exist-xyz"),
    );
    expect(hubs).toEqual([]);
  });
});

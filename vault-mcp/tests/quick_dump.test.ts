import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";

vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { quickDumpTool } from "../src/tools/quick_dump.js";
import { vaultPath } from "../src/lib/vault.js";

const INBOX = () => path.join(vaultPath(), "01 Inbox");

async function inboxFilesMatching(needle: string): Promise<string[]> {
  const entries = await fs.readdir(INBOX());
  return entries.filter((f) => f.includes(needle)).sort();
}

describe("quick_dump (atomare Inbox-Notizen)", () => {
  test("creates one file per thought with timestamp + title name", async () => {
    const marker = `T${randomUUID().slice(0, 8)}`;
    const res = await quickDumpTool.handler({
      text: "Webhook-Idee: Coolify per GitHub-Webhook deployen.",
      title: `Coolify Webhook ${marker}`,
    });
    expect(res.isError).toBeUndefined();

    const hits = await inboxFilesMatching(marker);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{4} Coolify Webhook /);

    const parsed = matter(await fs.readFile(path.join(INBOX(), hits[0]!), "utf8"));
    expect(parsed.data.tags).toEqual(["inbox"]);
    expect(parsed.data.erstellt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.content).toContain("Webhook-Idee: Coolify per GitHub-Webhook deployen.");
  });

  test("derives the title from the first words when none is given", async () => {
    const marker = `M${randomUUID().slice(0, 8)}`;
    const res = await quickDumpTool.handler({
      text: `Nginx ${marker} Cache Header pruefen bei naechstem Deploy unbedingt`,
    });
    expect(res.isError).toBeUndefined();
    const hits = await inboxFilesMatching(marker);
    expect(hits).toHaveLength(1);
    // Derived from the first ~6 words, used as filename title.
    expect(hits[0]).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2} \\d{4} Nginx ${marker} Cache Header`));
  });

  test("avoids filename collisions with a numeric suffix", async () => {
    const marker = `K${randomUUID().slice(0, 8)}`;
    await quickDumpTool.handler({ text: "erster", title: `Kollision ${marker}` });
    await quickDumpTool.handler({ text: "zweiter", title: `Kollision ${marker}` });
    const hits = await inboxFilesMatching(marker);
    expect(hits).toHaveLength(2);
    const contents = await Promise.all(
      hits.map(async (h) => matter(await fs.readFile(path.join(INBOX(), h), "utf8")).content),
    );
    expect(contents.join("\n")).toContain("erster");
    expect(contents.join("\n")).toContain("zweiter");
  });
});

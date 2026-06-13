import { describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

vi.mock("../src/lib/git.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/git.js")>();
  return { ...mod, markDirty: vi.fn() };
});

import { listInboxTool } from "../src/tools/list_inbox.js";
import { vaultPath } from "../src/lib/vault.js";

const INBOX = () => path.join(vaultPath(), "01 Inbox");

async function makeInboxNote(name: string, body: string): Promise<void> {
  await fs.mkdir(INBOX(), { recursive: true });
  await fs.writeFile(
    path.join(INBOX(), name),
    `---\ntags: [inbox]\nerstellt: 2026-06-01\n---\n\n${body}\n`,
    "utf8",
  );
}

describe("list_inbox (atomare Inbox-Notizen)", () => {
  test("lists atomic notes newest-first with a snippet", async () => {
    const marker = `L${randomUUID().slice(0, 8)}`;
    await makeInboxNote(`2026-01-01 0900 Alt ${marker}.md`, `alter Gedanke ${marker}`);
    await makeInboxNote(`2026-01-02 0900 Neu ${marker}.md`, `neuer Gedanke ${marker}`);

    const res = await listInboxTool.handler({ limit: 200 });
    const text = res.content[0]!.text;
    expect(text).toContain(`Neu ${marker}`);
    expect(text).toContain(`Alt ${marker}`);
    expect(text).toContain(`neuer Gedanke ${marker}`);
    // newest first
    expect(text.indexOf(`Neu ${marker}`)).toBeLessThan(text.indexOf(`Alt ${marker}`));
  });

  test("excludes underscore files and the legacy Brain Dump from the listing", async () => {
    const marker = `X${randomUUID().slice(0, 8)}`;
    await makeInboxNote(`_kuratierung.md`, `kuratierungs-inhalt ${marker}`);
    await makeInboxNote(`2026-01-03 0900 Sichtbar ${marker}.md`, "sichtbar");

    const res = await listInboxTool.handler({ limit: 200 });
    const text = res.content[0]!.text;
    expect(text).toContain(`Sichtbar ${marker}`);
    expect(text).not.toContain(`kuratierungs-inhalt ${marker}`);
  });
});

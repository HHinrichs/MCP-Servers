import { describe, expect, test } from "vitest";
import { parseInboxFilename } from "../src/jobs/inbox_curation.js";

describe("parseInboxFilename", () => {
  test("parses 'YYYY-MM-DD HHMM Titel.md' as Berlin local time", () => {
    const d = parseInboxFilename("2026-06-13 0242 Deploy-Check.md");
    expect(d).not.toBeNull();
    // 02:42 Berlin in June = CEST (UTC+2) → 00:42 UTC
    expect(d!.toISOString()).toBe("2026-06-13T00:42:00.000Z");
  });

  test("parses winter timestamps with CET offset", () => {
    const d = parseInboxFilename("2026-01-15 1000 Wintergedanke.md");
    expect(d!.toISOString()).toBe("2026-01-15T09:00:00.000Z");
  });

  test("returns null for non-matching names", () => {
    expect(parseInboxFilename("Brain Dump.md")).toBeNull();
    expect(parseInboxFilename("_kuratierung.md")).toBeNull();
    expect(parseInboxFilename("2026-06-13 Notiz ohne Uhrzeit.md")).toBeNull();
  });
});

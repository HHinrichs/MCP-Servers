import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FALLBACK_INSTRUCTIONS, loadInstructions } from "../src/lib/instructions.js";

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "instr-test-"));
  return path.join(dir, "AGENTS.md");
}

describe("loadInstructions", () => {
  test("returns the AGENTS.md content when the file exists", async () => {
    const file = await tmpFile();
    await fs.writeFile(file, "# Vault-Regeln\n\nImmer find_similar zuerst.\n", "utf8");
    const result = await loadInstructions(file);
    expect(result).toContain("# Vault-Regeln");
    expect(result).toContain("find_similar zuerst");
  });

  test("falls back when the file is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "instr-test-"));
    const result = await loadInstructions(path.join(dir, "AGENTS.md"));
    expect(result).toBe(FALLBACK_INSTRUCTIONS);
  });

  test("falls back when the file is empty or whitespace", async () => {
    const file = await tmpFile();
    await fs.writeFile(file, "   \n\n  ", "utf8");
    const result = await loadInstructions(file);
    expect(result).toBe(FALLBACK_INSTRUCTIONS);
  });

  test("fallback tells the client that AGENTS.md is missing", () => {
    expect(FALLBACK_INSTRUCTIONS).toContain("AGENTS.md");
  });
});

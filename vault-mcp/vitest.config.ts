import { defineConfig } from "vitest/config";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// git.ts validates these env vars at import time and simple-git requires the
// directory to exist. Point everything at a throwaway dir so unit tests can
// never touch a real vault clone.
const TEST_VAULT = path.join(os.tmpdir(), "vault-mcp-test-vault");
mkdirSync(TEST_VAULT, { recursive: true });

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      VAULT_REPO_PATH: TEST_VAULT,
      VAULT_REPO_REMOTE: "git@example.invalid:nobody/nothing.git",
      SSH_KEY_PATH: path.join(TEST_VAULT, "no-such-key"),
    },
  },
});

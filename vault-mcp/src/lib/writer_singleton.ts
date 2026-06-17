// Process-global Writer singleton. Tools/jobs call getWriter(); index.ts builds
// the real one at boot; tests inject a fake.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createRealGitHub, parseRepoSlug } from "./github.js";
import { makeWriter, type Writer } from "./writes.js";
import { vaultPath } from "./git.js";

let singleton: Writer | null = null;

export function getWriter(): Writer {
  if (!singleton) throw new Error("writer not configured");
  return singleton;
}
export function setWriter(w: Writer | null): void {
  singleton = w;
}

/** Write content into the local read-mirror so the index sees it immediately. */
async function mirrorWrite(rel: string, content: string | null): Promise<void> {
  const abs = vaultPath(rel);
  if (content === null) {
    await fs.rm(abs, { force: true });
  } else {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
}

export function configureRealWriter(): Writer {
  const remote = process.env.VAULT_REPO_REMOTE!;
  const { owner, repo } = parseRepoSlug(remote);
  const gh = createRealGitHub({
    owner,
    repo,
    branch: process.env.VAULT_REPO_BRANCH ?? "main",
    token: process.env.GITHUB_TOKEN!,
    authorName: process.env.GIT_AUTHOR_NAME ?? "Vault MCP",
    authorEmail: process.env.GIT_AUTHOR_EMAIL ?? "mcp@verdara-homegrow.de",
  });
  const w = makeWriter(gh, mirrorWrite);
  setWriter(w);
  return w;
}

import { simpleGit, type SimpleGit } from "simple-git";
import path from "node:path";

const REPO_PATH = process.env.VAULT_REPO_PATH;
const REPO_REMOTE = process.env.VAULT_REPO_REMOTE; // https://github.com/<owner>/<repo>.git
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const BRANCH = process.env.VAULT_REPO_BRANCH ?? "main";

if (!REPO_PATH || !REPO_REMOTE || !GITHUB_TOKEN) {
  throw new Error("VAULT_REPO_PATH, VAULT_REPO_REMOTE, GITHUB_TOKEN must be set");
}

/** Remote URL with the token injected for HTTPS auth (never logged). */
function authedRemote(): string {
  return REPO_REMOTE!.replace("https://", `https://x-access-token:${GITHUB_TOKEN}@`);
}

const git: SimpleGit = simpleGit(REPO_PATH);

export function vaultPath(...segments: string[]): string {
  return path.join(REPO_PATH!, ...segments);
}

export function getGit(): SimpleGit {
  return git;
}

/**
 * Clone if absent; otherwise hard-reset to origin. Safe to call at boot — the
 * mirror never holds local-only work (all writes go origin-first via the
 * GitHub API), so a reset can never lose data or wedge.
 */
export async function ensureRepoCloned(): Promise<void> {
  const fs = await import("node:fs/promises");
  let present = false;
  try {
    await fs.access(path.join(REPO_PATH!, ".git"));
    present = true;
  } catch {
    present = false;
  }
  if (!present) {
    console.log(`[git] cloning ${REPO_REMOTE} -> ${REPO_PATH}`);
    await fs.mkdir(path.dirname(REPO_PATH!), { recursive: true });
    await simpleGit().clone(authedRemote(), REPO_PATH!);
    await git.remote(["set-url", "origin", authedRemote()]);
  } else {
    console.log(`[git] repo present at ${REPO_PATH}, hard-resetting mirror to origin`);
    await git.remote(["set-url", "origin", authedRemote()]);
    await refreshMirror();
  }
}

let refreshing: Promise<void> | null = null;
/** fetch + hard-reset the mirror to origin/<branch>. Single-flight. */
export function refreshMirror(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await git.fetch("origin", BRANCH);
      await git.reset(["--hard", `origin/${BRANCH}`]);
    } catch (e) {
      console.error("[git] mirror refresh failed (will retry next tick):", e);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

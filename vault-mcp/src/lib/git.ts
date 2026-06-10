import { simpleGit, type SimpleGit } from "simple-git";
import path from "node:path";

const REPO_PATH = process.env.VAULT_REPO_PATH;
const REPO_REMOTE = process.env.VAULT_REPO_REMOTE;
const SSH_KEY_PATH = process.env.SSH_KEY_PATH;
const AUTHOR_NAME = process.env.GIT_AUTHOR_NAME ?? "Vault MCP";
const AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL ?? "mcp@verdara-homegrow.de";
const DEBOUNCE_MS = Number(process.env.PUSH_DEBOUNCE_MS ?? "30000");

if (!REPO_PATH || !REPO_REMOTE || !SSH_KEY_PATH) {
  throw new Error("VAULT_REPO_PATH, VAULT_REPO_REMOTE, SSH_KEY_PATH must be set");
}

// Force git to use our deploy key, skip strict host checking for the initial clone.
const GIT_SSH_COMMAND = `ssh -i ${SSH_KEY_PATH} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`;

const git: SimpleGit = simpleGit(REPO_PATH, {
  config: [`core.sshCommand=${GIT_SSH_COMMAND}`],
});

export function vaultPath(...segments: string[]): string {
  return path.join(REPO_PATH!, ...segments);
}

export async function ensureRepoCloned(): Promise<void> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(path.join(REPO_PATH!, ".git"));
    // Already present, just fetch latest.
    await git.fetch().pull("origin", "main", { "--rebase": "true" });
  } catch {
    console.log(`[git] cloning ${REPO_REMOTE} -> ${REPO_PATH}`);
    const parent = path.dirname(REPO_PATH!);
    await fs.mkdir(parent, { recursive: true });
    await simpleGit({ config: [`core.sshCommand=${GIT_SSH_COMMAND}`] }).clone(
      REPO_REMOTE!,
      REPO_PATH!,
    );
  }
  await git.addConfig("user.name", AUTHOR_NAME, false, "local");
  await git.addConfig("user.email", AUTHOR_EMAIL, false, "local");
  await git.addConfig("core.sshCommand", GIT_SSH_COMMAND, false, "local");
}

// --- Debounced commit + push ---

let debounceTimer: NodeJS.Timeout | null = null;
let pendingMessages: string[] = [];
let inflight: Promise<void> | null = null;

async function commitAndPush(): Promise<void> {
  debounceTimer = null;
  const msgs = pendingMessages.slice();
  pendingMessages = [];
  if (msgs.length === 0) return;

  await git.add(".");
  const status = await git.status();
  if (status.files.length === 0) {
    console.log("[git] nothing to commit");
    return;
  }

  const summary: string =
    msgs.length === 1
      ? (msgs[0] ?? "vault update")
      : `vault-mcp: ${msgs.length} updates\n\n${msgs.map((m) => `- ${m}`).join("\n")}`;

  try {
    await git.commit(summary);
    // Rebase-pull guards against concurrent updates from the user's local Obsidian.
    try {
      await git.pull("origin", "main", { "--rebase": "true" });
    } catch (e) {
      console.warn("[git] rebase pull failed (continuing to push):", e);
    }
    await git.push("origin", "main");
    console.log(`[git] pushed: ${summary.split("\n")[0] ?? summary}`);
  } catch (e) {
    console.error("[git] commit/push failed:", e);
    // Re-queue messages so the next dirty trigger retries.
    pendingMessages.unshift(...msgs);
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    // Chain onto any in-flight push to serialize.
    inflight = (inflight ?? Promise.resolve()).then(commitAndPush);
  }, DEBOUNCE_MS);
}

export function markDirty(message: string): void {
  pendingMessages.push(message);
  scheduleFlush();
}

/** Force-flush pending changes immediately (used by background jobs). */
export async function flushNow(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  inflight = (inflight ?? Promise.resolve()).then(commitAndPush);
  await inflight;
}

export function getGit(): SimpleGit {
  return git;
}

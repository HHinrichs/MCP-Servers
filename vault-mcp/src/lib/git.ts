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

// Configure git's SSH command via env var — git reads it natively, no need
// for simple-git's `allowUnsafeSshCommand` opt-in. known_hosts is written to
// /tmp because the container's $HOME (/home/node) is read-only-ish without prep.
process.env.GIT_SSH_COMMAND = [
  "ssh",
  `-i ${SSH_KEY_PATH}`,
  "-o IdentitiesOnly=yes",
  "-o UserKnownHostsFile=/tmp/known_hosts",
  "-o StrictHostKeyChecking=accept-new",
].join(" ");

const git: SimpleGit = simpleGit(REPO_PATH);

export function vaultPath(...segments: string[]): string {
  return path.join(REPO_PATH!, ...segments);
}

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
    const parent = path.dirname(REPO_PATH!);
    await fs.mkdir(parent, { recursive: true });
    await simpleGit().clone(REPO_REMOTE!, REPO_PATH!);
  } else {
    console.log(`[git] repo present at ${REPO_PATH}, fetching latest`);
    // A conflicting pull must never crash the boot (restart loop) or leave the
    // repo in a half-rebase state. Worst case we run on a slightly stale
    // checkout; the push path retries the rebase on the next write anyway.
    try {
      await git.fetch();
      await git.pull("origin", "main", { "--rebase": "true" });
    } catch (e) {
      console.error("[git] boot pull failed — aborting any in-progress rebase and continuing:", e);
      try {
        await git.rebase(["--abort"]);
      } catch {
        // no rebase in progress
      }
    }
  }

  await git.addConfig("user.name", AUTHOR_NAME, false, "local");
  await git.addConfig("user.email", AUTHOR_EMAIL, false, "local");
}

// --- Debounced commit + push ---

let debounceTimer: NodeJS.Timeout | null = null;
let pendingMessages: string[] = [];
let inflight: Promise<void> | null = null;

async function commitAndPush(): Promise<void> {
  debounceTimer = null;
  const msgs = pendingMessages.slice();
  pendingMessages = [];

  try {
    await git.add(".");
    const status = await git.status();

    if (status.files.length > 0) {
      const summary: string =
        msgs.length === 0
          ? "vault update"
          : msgs.length === 1
            ? (msgs[0] ?? "vault update")
            : `vault-mcp: ${msgs.length} updates\n\n${msgs.map((m) => `- ${m}`).join("\n")}`;
      await git.commit(summary);
      console.log(`[git] committed: ${summary.split("\n")[0] ?? summary}`);
    } else if (status.ahead === 0) {
      // Nothing staged and nothing waiting to go out.
      if (msgs.length > 0) console.log("[git] nothing to commit");
      return;
    } else {
      // Nothing staged, but an earlier commit never made it out (push failed
      // after a successful commit). Fall through and push it now.
      console.log(`[git] ${status.ahead} unpushed commit(s) pending — pushing`);
    }

    // Rebase onto remote before pushing (Hannes pushes to the same repo).
    // A failed rebase is aborted immediately so the repo never sits in a
    // half-rebase state; the push below then surfaces the real divergence.
    try {
      await git.pull("origin", "main", { "--rebase": "true" });
    } catch (e) {
      console.warn("[git] rebase pull failed — aborting rebase:", e);
      try {
        await git.rebase(["--abort"]);
      } catch {
        // no rebase in progress
      }
    }

    await git.push("origin", "main");
    console.log("[git] pushed");
  } catch (e) {
    console.error("[git] commit/push failed, re-queueing for retry:", e);
    // Re-queue messages so the next flush retries; an already-created commit
    // is picked up via the status.ahead branch above.
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

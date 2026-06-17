// Origin-first write orchestration: fetch current content from origin, apply a
// pure transform, commit via the Git-Data-API with CAS retry, then mirror the
// result locally for instant read-after-write. Owns write-health for /healthz.
import type { GitHubClient, FileChange } from "./github.js";
import { RefMovedError } from "./github.js";

const MAX_ATTEMPTS = 5;

interface WriteHealth {
  lastWriteOkAt: number | null;
  lastWriteError: string | null;
  consecutiveWriteFailures: number;
}
let health: WriteHealth = { lastWriteOkAt: null, lastWriteError: null, consecutiveWriteFailures: 0 };

export function getWriteHealth(): WriteHealth {
  return { ...health };
}
export function __resetWriteHealthForTests(): void {
  health = { lastWriteOkAt: null, lastWriteError: null, consecutiveWriteFailures: 0 };
}

function recordOk(): void {
  health = { lastWriteOkAt: Date.now(), lastWriteError: null, consecutiveWriteFailures: 0 };
}
function recordFail(e: unknown): void {
  health = {
    lastWriteOkAt: health.lastWriteOkAt,
    lastWriteError: e instanceof Error ? e.message : String(e),
    consecutiveWriteFailures: health.consecutiveWriteFailures + 1,
  };
}

async function backoff(attempt: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 50 * attempt));
}

export type MirrorWrite = (relPath: string, content: string | null) => Promise<void>;

export interface Writer {
  writeToOrigin(relPath: string, transform: (raw: string | null) => string, message: string): Promise<void>;
  writeMulti(
    relPaths: string[],
    transform: (raws: (string | null)[]) => FileChange[],
    message: string,
  ): Promise<void>;
}

export function makeWriter(gh: GitHubClient, mirror: MirrorWrite): Writer {
  async function attemptLoop(
    read: (commitSha: string) => Promise<{ changes: FileChange[]; mirrorOps: [string, string | null][] }>,
    message: string,
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const head = await gh.getHead();
        const { changes, mirrorOps } = await read(head.commitSha);
        await gh.commitFiles(head.commitSha, changes, message);
        for (const [rel, content] of mirrorOps) await mirror(rel, content);
        recordOk();
        return;
      } catch (e) {
        lastErr = e;
        if (e instanceof RefMovedError && attempt < MAX_ATTEMPTS) {
          await backoff(attempt);
          continue;
        }
        recordFail(e);
        throw e;
      }
    }
    recordFail(lastErr);
    throw lastErr;
  }

  return {
    async writeToOrigin(relPath, transform, message) {
      await attemptLoop(async (commitSha) => {
        const raw = await gh.getFileContent(relPath, commitSha);
        const next = transform(raw);
        return { changes: [{ path: relPath, content: next }], mirrorOps: [[relPath, next]] };
      }, message);
    },

    async writeMulti(relPaths, transform, message) {
      await attemptLoop(async (commitSha) => {
        const raws = await Promise.all(relPaths.map((p) => gh.getFileContent(p, commitSha)));
        const changes = transform(raws);
        const mirrorOps = changes.map(
          (c) => [c.path, c.delete ? null : (c.content ?? "")] as [string, string | null],
        );
        return { changes, mirrorOps };
      }, message);
    },
  };
}

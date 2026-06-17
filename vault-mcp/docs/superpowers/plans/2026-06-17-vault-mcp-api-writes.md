# GitHub-API Writes + Read-Only Mirror — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the silent sync wedge impossible by writing every vault change origin-first via the GitHub Git-Data-API; demote the local clone to a reset-safe read-only mirror for the embedding index.

**Architecture:** Tools call pure content-transforms `(raw) → raw`; an orchestration layer fetches the current file from origin, applies the transform, and commits via blobs→tree→commit→updateRef with `force:false` (compare-and-swap). On CAS conflict it re-fetches and re-applies (appends never truly conflict). After a successful commit it writes the same content into the mirror for instant read-after-write. A background loop keeps the mirror current with `fetch + reset --hard origin/main`. No local commit ever exists.

**Tech Stack:** TypeScript (ESM, Node 22), native `fetch` (no new dep), `gray-matter`, `simple-git` (read-mirror only), `vitest`.

**Spec:** `docs/superpowers/specs/2026-06-17-vault-mcp-api-writes-design.md`

**Out of scope (conscious YAGNI):**
- Cross-module lock between `reset --hard` and the index reconcile. The race is single-user, low-probability, and **self-healing** (a torn read yields a wrong content-hash → the section re-embeds on the next query). `refreshMirror()` is single-flight against itself. Revisit only if it ever bites.
- Webhook-driven mirror refresh (periodic poll is enough).
- Commit batching (one commit per write is simpler and truthful).

---

## Task 1: GitHub Git-Data-API client + in-memory fake

**Files:**
- Create: `src/lib/github.ts`
- Test: `tests/github.ts` is NOT needed (the fake is exercised via writes.test.ts in Task 3); this task ships the client + fake + a focused unit test for the fake's CAS semantics.
- Test: `tests/github_fake.test.ts`

- [ ] **Step 1: Write the failing test for the fake's CAS semantics**

```typescript
// tests/github_fake.test.ts
import { describe, expect, test } from "vitest";
import { createFakeGitHub, RefMovedError } from "../src/lib/github.js";

describe("FakeGitHub", () => {
  test("getFileContent returns null for a missing path", async () => {
    const gh = createFakeGitHub({});
    const head = await gh.getHead();
    expect(await gh.getFileContent("missing.md", head.commitSha)).toBeNull();
  });

  test("commitFiles writes content and advances HEAD", async () => {
    const gh = createFakeGitHub({ "a.md": "one" });
    const head = await gh.getHead();
    await gh.commitFiles(head.commitSha, [{ path: "a.md", content: "one\ntwo" }], "msg");
    const head2 = await gh.getHead();
    expect(head2.commitSha).not.toBe(head.commitSha);
    expect(await gh.getFileContent("a.md", head2.commitSha)).toBe("one\ntwo");
  });

  test("commitFiles with a stale base sha throws RefMovedError", async () => {
    const gh = createFakeGitHub({ "a.md": "one" });
    const stale = (await gh.getHead()).commitSha;
    // someone else commits first, advancing HEAD
    await gh.commitFiles(stale, [{ path: "a.md", content: "x" }], "other");
    // our commit against the now-stale base must be rejected
    await expect(
      gh.commitFiles(stale, [{ path: "a.md", content: "y" }], "ours"),
    ).rejects.toBeInstanceOf(RefMovedError);
  });

  test("commitFiles can delete a path", async () => {
    const gh = createFakeGitHub({ "a.md": "one", "b.md": "two" });
    const head = await gh.getHead();
    await gh.commitFiles(head.commitSha, [{ path: "a.md", delete: true }], "rm");
    const head2 = await gh.getHead();
    expect(await gh.getFileContent("a.md", head2.commitSha)).toBeNull();
    expect(await gh.getFileContent("b.md", head2.commitSha)).toBe("two");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/github_fake.test.ts`
Expected: FAIL — `../src/lib/github.js` has no exports yet.

- [ ] **Step 3: Implement `src/lib/github.ts`**

```typescript
// src/lib/github.ts
// Thin GitHub Git-Data-API client over native fetch (Node 22). Used to commit
// vault changes origin-first with compare-and-swap on the branch ref, so the
// server never holds a local commit that could diverge/wedge.

export interface FileChange {
  path: string;
  content?: string; // present unless delete
  delete?: boolean;
}

export interface Head {
  commitSha: string;
  treeSha: string;
}

/** Thrown when updateRef(force:false) is rejected because HEAD moved (CAS fail). */
export class RefMovedError extends Error {
  constructor(message = "ref moved (compare-and-swap failed)") {
    super(message);
    this.name = "RefMovedError";
  }
}

export interface GitHubClient {
  getHead(): Promise<Head>;
  getFileContent(path: string, ref: string): Promise<string | null>;
  commitFiles(baseCommitSha: string, changes: FileChange[], message: string): Promise<string>;
}

interface RealOpts {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  authorName: string;
  authorEmail: string;
}

/** Parse owner/repo from an https or ssh GitHub remote URL. */
export function parseRepoSlug(remote: string): { owner: string; repo: string } {
  const m = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m || !m[1] || !m[2]) throw new Error(`cannot parse owner/repo from remote: ${remote}`);
  return { owner: m[1], repo: m[2] };
}

export function createRealGitHub(opts: RealOpts): GitHubClient {
  const base = `https://api.github.com/repos/${opts.owner}/${opts.repo}`;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  async function api(method: string, url: string, body?: unknown): Promise<Response> {
    return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function json<T>(res: Response): Promise<T> {
    if (!res.ok) throw new Error(`github ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  return {
    async getHead(): Promise<Head> {
      const ref = await json<{ object: { sha: string } }>(
        await api("GET", `${base}/git/ref/heads/${opts.branch}`),
      );
      const commit = await json<{ tree: { sha: string } }>(
        await api("GET", `${base}/git/commits/${ref.object.sha}`),
      );
      return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
    },

    async getFileContent(path: string, ref: string): Promise<string | null> {
      const res = await api(
        "GET",
        `${base}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${ref}`,
      );
      if (res.status === 404) return null;
      const data = await json<{ content: string; encoding: string }>(res);
      return Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf8");
    },

    async commitFiles(baseCommitSha: string, changes: FileChange[], message: string): Promise<string> {
      const baseCommit = await json<{ tree: { sha: string } }>(
        await api("GET", `${base}/git/commits/${baseCommitSha}`),
      );
      const tree = await Promise.all(
        changes.map(async (c) => {
          if (c.delete) return { path: c.path, mode: "100644", type: "blob", sha: null };
          const blob = await json<{ sha: string }>(
            await api("POST", `${base}/git/blobs`, { content: c.content ?? "", encoding: "utf-8" }),
          );
          return { path: c.path, mode: "100644", type: "blob", sha: blob.sha };
        }),
      );
      const newTree = await json<{ sha: string }>(
        await api("POST", `${base}/git/trees`, { base_tree: baseCommit.tree.sha, tree }),
      );
      const now = new Date().toISOString();
      const commit = await json<{ sha: string }>(
        await api("POST", `${base}/git/commits`, {
          message,
          tree: newTree.sha,
          parents: [baseCommitSha],
          author: { name: opts.authorName, email: opts.authorEmail, date: now },
          committer: { name: opts.authorName, email: opts.authorEmail, date: now },
        }),
      );
      const upd = await api("PATCH", `${base}/git/refs/heads/${opts.branch}`, {
        sha: commit.sha,
        force: false,
      });
      if (upd.status === 422) throw new RefMovedError();
      if (!upd.ok) throw new Error(`github updateRef ${upd.status}: ${await upd.text()}`);
      return commit.sha;
    },
  };
}

/** In-memory GitHub for tests: a path→content map + a monotonic HEAD. */
export function createFakeGitHub(initial: Record<string, string>): GitHubClient & {
  forceConflictOnce(): void;
} {
  let files = new Map(Object.entries(initial));
  let counter = 1;
  let headSha = `sha${counter}`;
  let pendingConflict = false;

  return {
    forceConflictOnce() {
      pendingConflict = true;
    },
    async getHead(): Promise<Head> {
      return { commitSha: headSha, treeSha: `tree-${headSha}` };
    },
    async getFileContent(path: string): Promise<string | null> {
      return files.has(path) ? (files.get(path) as string) : null;
    },
    async commitFiles(baseCommitSha: string, changes: FileChange[]): Promise<string> {
      if (pendingConflict) {
        pendingConflict = false;
        throw new RefMovedError();
      }
      if (baseCommitSha !== headSha) throw new RefMovedError();
      const next = new Map(files);
      for (const c of changes) {
        if (c.delete) next.delete(c.path);
        else next.set(c.path, c.content ?? "");
      }
      files = next;
      counter += 1;
      headSha = `sha${counter}`;
      return headSha;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/github_fake.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/lib/github.ts tests/github_fake.test.ts
git commit -m "feat(github): Git-Data-API client + in-memory fake (CAS via force:false)"
```

---

## Task 2: Pure content transforms

Extract the existing file-mutation logic from `src/lib/vault.ts` into pure `(raw) → raw` functions so the API write layer can re-apply them on CAS conflict. `vault.ts` keeps the fs helpers (still used for reads); the pure cores move to `transforms.ts` and `vault.ts`'s `appendUnderSection` is reimplemented on top of them in Task 5's wiring (left intact for now to keep the suite green).

**Files:**
- Create: `src/lib/transforms.ts`
- Test: `tests/transforms.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/transforms.test.ts
import { describe, expect, test } from "vitest";
import {
  appendUnderSectionContent,
  createNoteContent,
  splitNoteContent,
} from "../src/lib/transforms.js";

describe("appendUnderSectionContent", () => {
  test("creates a fresh note when raw is null", () => {
    const out = appendUnderSectionContent(null, "Notizen", "- hallo", {
      title: "Test",
      tags: ["projekt"],
    });
    expect(out).toContain("# Test");
    expect(out).toContain("## Notizen");
    expect(out).toContain("- hallo");
    expect(out).toMatch(/updated:/);
  });

  test("appends under an existing section, before the next heading", () => {
    const raw = "---\ntags: []\n---\n\n# T\n\n## A\n\nalt\n\n## B\n\nb\n";
    const out = appendUnderSectionContent(raw, "A", "- neu");
    // "- neu" lands inside A, before "## B"
    expect(out.indexOf("- neu")).toBeGreaterThan(out.indexOf("## A"));
    expect(out.indexOf("- neu")).toBeLessThan(out.indexOf("## B"));
  });

  test("re-applying on already-appended content is additive (CAS-retry safe)", () => {
    const raw = "---\ntags: []\n---\n\n# T\n\n## A\n\nalt\n";
    const once = appendUnderSectionContent(raw, "A", "- x");
    const twice = appendUnderSectionContent(once, "A", "- x");
    expect((twice.match(/- x/g) ?? []).length).toBe(2); // each apply adds one
  });
});

describe("createNoteContent", () => {
  test("serializes frontmatter + body with an updated timestamp", () => {
    const out = createNoteContent({ tags: ["inbox"], erstellt: "2026-06-17" }, "\n# Titel\n\nrumpf\n");
    expect(out).toContain("# Titel");
    expect(out).toContain("rumpf");
    expect(out).toMatch(/updated:/);
  });
});

describe("splitNoteContent", () => {
  test("extracts a section into target and leaves a stub in source", () => {
    const raw = "---\ntags: [projekt]\n---\n\n# Hub\n\n## Keep\n\nk\n\n## Move\n\nm-body\n";
    const { source, target } = splitNoteContent(raw, "Move", "Sub", "Hub", "2026-06-17 12:00");
    expect(target).toContain("# Sub");
    expect(target).toContain("m-body");
    expect(target).toContain("[[Hub]]");
    expect(source).toContain("ausgelagert nach [[Sub]]");
    expect(source).not.toContain("m-body");
    expect(source).toContain("## Keep");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/transforms.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/lib/transforms.ts`**

Port the exact logic from `vault.ts` (`appendUnderSection`, `readOrInitMarkdown`, `writeMarkdown`) and `split_note.ts`, but pure (content in/out). Reuse `escapeRegex`, `timestampBerlin`, `todayBerlin` from `vault.ts`.

```typescript
// src/lib/transforms.ts
// Pure content transforms: (rawFileContent | null) -> newRawFileContent.
// No fs, no network — so the API write layer can re-apply them verbatim on a
// CAS conflict. Frontmatter `updated` is stamped here (single source of truth).
import matter from "gray-matter";
import { escapeRegex, timestampBerlin, todayBerlin } from "./vault.js";

interface InitMeta {
  title?: string;
  tags?: string[];
}

function parseOrInit(
  raw: string | null,
  init: InitMeta,
): { frontmatter: Record<string, unknown>; body: string } {
  if (raw === null) {
    return {
      frontmatter: { tags: init.tags ?? [], erstellt: todayBerlin(), updated: todayBerlin() },
      body: init.title ? `\n# ${init.title}\n\n` : "\n",
    };
  }
  const parsed = matter(raw);
  return { frontmatter: parsed.data, body: parsed.content };
}

function serialize(frontmatter: Record<string, unknown>, body: string): string {
  const fm = { ...frontmatter, updated: timestampBerlin() };
  return matter.stringify(body, fm);
}

/** Append a block under a `## Section` (creating the section/file as needed). */
export function appendUnderSectionContent(
  raw: string | null,
  section: string | null,
  block: string,
  init: InitMeta = {},
): string {
  const { frontmatter, body } = parseOrInit(raw, init);
  const trimmedBlock = block.replace(/\s+$/, "") + "\n";

  let newBody: string;
  if (section === null) {
    newBody = body.replace(/\s+$/, "") + "\n\n" + trimmedBlock;
  } else {
    const headerRegex = new RegExp(`^## ${escapeRegex(section)}\\s*$`, "m");
    const headerMatch = body.match(headerRegex);
    if (!headerMatch || headerMatch.index === undefined) {
      newBody = body.replace(/\s+$/, "") + "\n\n## " + section + "\n\n" + trimmedBlock;
    } else {
      const sectionHeaderEnd = headerMatch.index + headerMatch[0].length;
      const remainder = body.slice(sectionHeaderEnd);
      const nextMatch = remainder.match(/^#{1,6} /m);
      const insertAt =
        nextMatch && nextMatch.index !== undefined ? sectionHeaderEnd + nextMatch.index : body.length;
      newBody =
        body.slice(0, insertAt).replace(/\s+$/, "") + "\n\n" + trimmedBlock + "\n" + body.slice(insertAt);
    }
  }
  return serialize(frontmatter, newBody);
}

/** Serialize a brand-new note from explicit frontmatter + body. */
export function createNoteContent(frontmatter: Record<string, unknown>, body: string): string {
  return serialize(frontmatter, body);
}

/** Split a `## Section` (with its `###` subsections) into a new note + stub. */
export function splitNoteContent(
  sourceRaw: string,
  section: string,
  targetName: string,
  sourceName: string,
  stamp: string,
): { source: string; target: string; extractedEmpty: boolean } {
  const parsed = matter(sourceRaw);
  const body = parsed.content;
  const headerRegex = new RegExp(`^## ${escapeRegex(section)}\\s*$`, "m");
  const headerMatch = body.match(headerRegex);
  if (!headerMatch || headerMatch.index === undefined) {
    throw new Error(`section '## ${section}' not found`);
  }
  const contentStart = headerMatch.index + headerMatch[0].length;
  const remainder = body.slice(contentStart);
  const nextMatch = remainder.match(/^#{1,2} /m);
  const contentEnd =
    nextMatch && nextMatch.index !== undefined ? contentStart + nextMatch.index : body.length;
  const extracted = body.slice(contentStart, contentEnd).trim();

  const sourceTags = Array.isArray(parsed.data.tags) ? parsed.data.tags : [];
  const target = serialize(
    { tags: sourceTags, erstellt: todayBerlin() },
    `\n# ${targetName}\n\n_(Ausgelagert aus [[${sourceName}]] am ${stamp})_\n\n${extracted}\n`,
  );
  const newBody =
    body.slice(0, contentStart).replace(/\s+$/, "") +
    `\n\n→ ausgelagert nach [[${targetName}]] _(${stamp})_\n\n` +
    body.slice(contentEnd);
  const source = serialize(parsed.data, newBody);
  return { source, target, extractedEmpty: extracted.length === 0 };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/transforms.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/lib/transforms.ts tests/transforms.test.ts
git commit -m "feat(transforms): pure (raw)->raw content transforms for API writes"
```

---

## Task 3: Write orchestration + write-health status

`writes.ts` ties the transform to the API client with CAS-retry, then mirrors the result. It also owns the write-health state that `/healthz` reports.

**Files:**
- Create: `src/lib/writes.ts`
- Test: `tests/writes.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/writes.test.ts
import { describe, expect, test, beforeEach } from "vitest";
import { createFakeGitHub } from "../src/lib/github.js";
import {
  makeWriter,
  getWriteHealth,
  __resetWriteHealthForTests,
} from "../src/lib/writes.js";

beforeEach(() => __resetWriteHealthForTests());

describe("writeToOrigin", () => {
  test("commits the transformed content and mirrors it", async () => {
    const gh = createFakeGitHub({ "a.md": "start" });
    const mirrored: Record<string, string> = {};
    const w = makeWriter(gh, async (rel, content) => {
      mirrored[rel] = content;
    });
    await w.writeToOrigin("a.md", (raw) => (raw ?? "") + "\n+line", "msg");
    expect(await gh.getFileContent("a.md", (await gh.getHead()).commitSha)).toBe("start\n+line");
    expect(mirrored["a.md"]).toBe("start\n+line");
    expect(getWriteHealth().lastWriteError).toBeNull();
  });

  test("retries the transform on a CAS conflict without losing the edit", async () => {
    const gh = createFakeGitHub({ "a.md": "base" });
    gh.forceConflictOnce(); // first commit attempt throws RefMovedError
    const w = makeWriter(gh, async () => {});
    await w.writeToOrigin("a.md", (raw) => (raw ?? "") + "\nX", "msg");
    expect(await gh.getFileContent("a.md", (await gh.getHead()).commitSha)).toBe("base\nX");
  });

  test("propagates a hard failure and records write-health error", async () => {
    const gh = createFakeGitHub({ "a.md": "base" });
    // Make every commit fail by always forcing a conflict.
    const w = makeWriter(
      { ...gh, commitFiles: async () => { throw new Error("boom"); } } as typeof gh,
      async () => {},
    );
    await expect(w.writeToOrigin("a.md", (r) => (r ?? "") + "y", "msg")).rejects.toThrow();
    expect(getWriteHealth().lastWriteError).toContain("boom");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/writes.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/lib/writes.ts`**

```typescript
// src/lib/writes.ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/writes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/lib/writes.ts tests/writes.test.ts
git commit -m "feat(writes): origin-first orchestration with CAS retry + write-health"
```

---

## Task 4: Read-only mirror + production wiring + write-health in /healthz

Rewrite `git.ts` to a pure read-mirror (no commits ever), wire the real writer singleton, repoint `/healthz` + `sync_status` to write-health.

**Files:**
- Modify: `src/lib/git.ts` (replace the write half)
- Create: `src/lib/writer_singleton.ts`
- Modify: `src/lib/sync_status.ts` (write-health shape)
- Modify: `tests/sync_status.test.ts`
- Modify: `src/server.ts` (/healthz uses write-health)

- [ ] **Step 1: Rewrite `src/lib/git.ts`**

Replace the whole file with the read-mirror version. Remote becomes HTTPS-with-token; `refreshMirror()` is single-flight `fetch + reset --hard`; boot always resets (never wedges).

```typescript
// src/lib/git.ts
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

/** Clone if absent; otherwise hard-reset to origin. Safe to call at boot — the
 * mirror never holds local-only work, so a reset can never lose data or wedge. */
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
```

- [ ] **Step 2: Create `src/lib/writer_singleton.ts`**

```typescript
// src/lib/writer_singleton.ts
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
```

- [ ] **Step 3: Update `src/lib/sync_status.ts` to write-health**

Replace `SyncState`/`evaluateSync` with the write-health shape. `stale` = there has been a write attempt and the last one failed.

```typescript
// src/lib/sync_status.ts
export interface SyncState {
  lastWriteOkAt: number | null;
  lastWriteError: string | null;
  consecutiveWriteFailures: number;
}

export interface SyncStatus extends SyncState {
  lastWriteAgeSec: number | null;
  stale: boolean;
}

export function evaluateSync(state: SyncState, now: number): SyncStatus {
  const lastWriteAgeSec =
    state.lastWriteOkAt === null ? null : Math.max(0, Math.round((now - state.lastWriteOkAt) / 1000));
  const stale = state.lastWriteError !== null;
  return { ...state, lastWriteAgeSec, stale };
}
```

- [ ] **Step 4: Rewrite `tests/sync_status.test.ts`**

```typescript
// tests/sync_status.test.ts
import { describe, expect, test } from "vitest";
import { evaluateSync, type SyncState } from "../src/lib/sync_status.js";

const base: SyncState = { lastWriteOkAt: null, lastWriteError: null, consecutiveWriteFailures: 0 };

describe("evaluateSync (write-health)", () => {
  test("stale when the last write failed", () => {
    const s = evaluateSync({ ...base, lastWriteError: "boom", consecutiveWriteFailures: 2 }, 1000);
    expect(s.stale).toBe(true);
  });
  test("not stale when the last write succeeded", () => {
    const s = evaluateSync({ ...base, lastWriteOkAt: 500, lastWriteError: null }, 1000);
    expect(s.stale).toBe(false);
  });
  test("lastWriteAgeSec is seconds since the last ok write", () => {
    expect(evaluateSync({ ...base, lastWriteOkAt: 10_000 }, 25_000).lastWriteAgeSec).toBe(15);
  });
  test("lastWriteAgeSec null when no write has succeeded yet", () => {
    expect(evaluateSync({ ...base, lastWriteOkAt: null }, 25_000).lastWriteAgeSec).toBeNull();
  });
});
```

- [ ] **Step 5: Update `/healthz` in `src/server.ts`**

Replace the `getSyncStatus` import + handler body. Remove the old `./lib/git.js` `getSyncStatus` import; build status from write-health.

Old (Task from 2026-06-17):
```typescript
import { getSyncStatus } from "./lib/git.js";
```
New:
```typescript
import { getWriteHealth } from "./lib/writes.js";
import { evaluateSync } from "./lib/sync_status.js";
```

Old handler:
```typescript
      const sync = await getSyncStatus();
      res.json({ status: "ok", sync });
```
New handler:
```typescript
      const sync = evaluateSync(getWriteHealth(), Date.now());
      res.json({ status: "ok", sync });
```

- [ ] **Step 6: Run the affected tests + typecheck**

Run: `npm test -- tests/sync_status.test.ts`
Expected: PASS (4 tests).
Run: `npm run typecheck`
Expected: **Will FAIL** on `git.ts` consumers (`markDirty`/`flushNow`/`getSyncStatus` removed). That is expected — Task 5 fixes every call site. Proceed to Task 5 before committing.

- [ ] **Step 7: Commit (after Task 5 makes typecheck pass)** — see Task 5, Step N.

---

## Task 5: Switch all tools + jobs to the writer

Replace every `markDirty(...)` + local fs write with a `getWriter()` call using a transform. Each tool keeps its validation/response; only the persistence changes. `vaultPath`-based read helpers stay (reads come from the mirror).

**Files (modify):** `src/tools/quick_dump.ts`, `add_to_project.ts`, `add_to_area.ts`, `add_to_context.ts`, `add_to_resource.ts`, `update_daily.ts`, `move_note.ts`, `split_note.ts`, `src/jobs/daily_recap.ts`, `src/jobs/inbox_curation.ts`

Shared helper: add a vault-relative path helper to `vault.ts` so transforms address files by repo-relative path.

- [ ] **Step 1: Add `relFromVault` to `src/lib/vault.ts`**

```typescript
// src/lib/vault.ts — add near resolveVaultPath
/** Repo-relative POSIX path of an absolute vault path (for GitHub API addressing). */
export function relFromVault(absPath: string): string {
  return path.relative(vaultPath(), absPath).split(path.sep).join("/");
}
```

- [ ] **Step 2: `quick_dump.ts` — create via writer**

Replace the `writeMarkdown(...)` + `markDirty(...)` block:
```typescript
    const abs = vaultPath(VAULT_DIRS.inbox, name);
    await writeMarkdown(
      abs,
      { tags: ["inbox"], erstellt: todayBerlin() },
      `\n# ${cleanTitle}\n\n${text}\n`,
    );
    markDirty(`quick_dump ${name}`);
```
with:
```typescript
    const rel = `${VAULT_DIRS.inbox}/${name}`;
    await getWriter().writeToOrigin(
      rel,
      () => createNoteContent({ tags: ["inbox"], erstellt: todayBerlin() }, `\n# ${cleanTitle}\n\n${text}\n`),
      `quick_dump ${name}`,
    );
```
Update imports: drop `markDirty`, `writeMarkdown`; add `import { getWriter } from "../lib/writer_singleton.js";` and `import { createNoteContent } from "../lib/transforms.js";`. (The `readIfExists` existence-probe for the numeric suffix stays — it reads the mirror, which is fine.)

- [ ] **Step 3: `add_to_project.ts` — append via writer**

Replace:
```typescript
    const target = await resolveProjectHubFile(project);
    await appendUnderSection(target, section, `- _(${stamp})_ ${text}\n`, {
      title: project,
      tags: ["projekt"],
    });
    markDirty(`add_to_project ${project} / ${section}`);
    const hint = await noteSizeHint(target);
```
with:
```typescript
    const target = await resolveProjectHubFile(project);
    const rel = relFromVault(target);
    await getWriter().writeToOrigin(
      rel,
      (raw) => appendUnderSectionContent(raw, section, `- _(${stamp})_ ${text}\n`, { title: project, tags: ["projekt"] }),
      `add_to_project ${project} / ${section}`,
    );
    const hint = await noteSizeHint(target);
```
Imports: drop `markDirty`, `appendUnderSection`; add `relFromVault` (from vault.js), `getWriter`, `appendUnderSectionContent`.

- [ ] **Step 4: `add_to_area.ts`, `add_to_context.ts`, `add_to_resource.ts`, `update_daily.ts` — same pattern**

Each currently does `await appendUnderSection(<file>, <section>, <block>, <init>); markDirty(<msg>);`. Replace with:
```typescript
    await getWriter().writeToOrigin(
      relFromVault(<file>),
      (raw) => appendUnderSectionContent(raw, <section>, <block>, <init>),
      <msg>,
    );
```
Concrete per file:
- `add_to_area.ts`: file `areaFile(area)`, init `{ title: area, tags: ["bereich"] }`, msg `` `add_to_area ${area} / ${section}` ``.
- `add_to_context.ts`: file `kontextFile(file)`, init `{ tags: ["kontext"] }`, msg `` `add_to_context ${file} / ${section}` `` (keep the existing block/section args).
- `add_to_resource.ts`: file `resourceFile(topic)`, init `{ title: topic, tags: ["ressource"] }`, msg `` `add_to_resource ${topic}` ``.
- `update_daily.ts`: file `dailyFile()`, init `{ title: <date>, tags: ["daily"] }`, msg `` `update_daily ${today}` ``.

In each: drop `markDirty`/`appendUnderSection` imports; add `relFromVault`, `getWriter`, `appendUnderSectionContent`. (Verify exact existing init/section/block by reading the file before editing — keep them identical.)

- [ ] **Step 5: `move_note.ts` — atomic path move via writer**

Replace the `fs.mkdir`+`fs.rename`+`markDirty` block:
```typescript
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    markDirty(`move_note ${from} -> ${to}`);
```
with:
```typescript
    await getWriter().writeMulti(
      [from],
      (raws) => {
        const content = raws[0];
        if (content === null) throw new Error(`source vanished: ${from}`);
        return [
          { path: from, delete: true },
          { path: to, content },
        ];
      },
      `move_note ${from} -> ${to}`,
    );
```
Note: `from`/`to` are already vault-relative (the tool's inputs). Keep the existing `resolveVaultPath` + `fs.access` existence checks (they read the mirror). Drop the `fs.rename`/`fs.mkdir`/`path` usage if now unused; drop `markDirty`; add `getWriter`.

- [ ] **Step 6: `split_note.ts` — source+target in one commit**

Replace the two `writeMarkdown(...)` calls + `markDirty` with one `writeMulti`:
```typescript
    const stamp = timestampBerlin();
    const sourceName = path.basename(source, ".md");
    const targetName = path.basename(target, ".md");
    await getWriter().writeMulti(
      [source],
      (raws) => {
        const raw = raws[0];
        if (raw === null) throw new Error(`source vanished: ${source}`);
        const { source: newSource, target: newTarget } = splitNoteContent(
          raw, section, targetName, sourceName, stamp,
        );
        return [
          { path: source, content: newSource },
          { path: target, content: newTarget },
        ];
      },
      `split_note ${source} § ${section} -> ${target}`,
    );
```
Keep the up-front validation (protected-root, source exists, target absent, section present — the section-present check can stay as the early `matter`/regex probe on the mirror, OR rely on `splitNoteContent` throwing; keep the early probe for the friendly error). Drop `writeMarkdown`, `markDirty`, the manual `newBody` block; add `getWriter`, `splitNoteContent`.

- [ ] **Step 7: `daily_recap.ts` — refresh mirror, then append via writer**

Replace:
```typescript
  const git = getGit();
```
with:
```typescript
  await refreshMirror(); // pull the API-made bot commits into the mirror before reading the log
  const git = getGit();
```
Replace:
```typescript
  await appendUnderSection(dailyFile(yesterday), "Tagesübersicht (auto)", block, {
    title: yesterday,
    tags: ["daily"],
  });
  markDirty(`daily_recap ${yesterday}`);
  await flushNow();
```
with:
```typescript
  await getWriter().writeToOrigin(
    relFromVault(dailyFile(yesterday)),
    (raw) => appendUnderSectionContent(raw, "Tagesübersicht (auto)", block, { title: yesterday, tags: ["daily"] }),
    `daily_recap ${yesterday}`,
  );
```
Imports: drop `flushNow`, `markDirty`, `appendUnderSection`; add `refreshMirror` (git.js), `relFromVault` (vault.js), `getWriter`, `appendUnderSectionContent`.

- [ ] **Step 8: `inbox_curation.ts` — write via writer**

Replace:
```typescript
  const file = curationFile();
  await ensureDir(file);
  await writeMarkdown(
    file,
    { tags: ["inbox", "kuratierung"], erstellt: today, updated: today },
    `\n# Inbox-Kuratierung\n${content}`,
  );
  markDirty(`inbox_curation: ${stale.length} stale notes`);
  await flushNow();
```
with:
```typescript
  await getWriter().writeToOrigin(
    relFromVault(curationFile()),
    () => createNoteContent({ tags: ["inbox", "kuratierung"], erstellt: today }, `\n# Inbox-Kuratierung\n${content}`),
    `inbox_curation: ${stale.length} stale notes`,
  );
```
(`_kuratierung.md` is overwritten wholesale each run — `createNoteContent` ignores prior content, which matches today's `writeMarkdown` overwrite.) Imports: drop `flushNow`, `markDirty`, `writeMarkdown`, `ensureDir`; add `relFromVault`, `getWriter`, `createNoteContent`. Reads (`fs.readdir`/`fs.stat`/`fs.readFile`) stay.

- [ ] **Step 9: Wire the writer + refresh loop into `src/index.ts`** (the last `getSyncStatus` consumer — must land in this same green commit)

In `src/index.ts`:
- Change the git import to drop `getSyncStatus` and add `refreshMirror`:
```typescript
import { ensureRepoCloned, vaultPath, refreshMirror } from "./lib/git.js";
import { configureRealWriter } from "./lib/writer_singleton.js";
```
- After `await ensureRepoCloned();` add:
```typescript
  configureRealWriter();
  console.log("[boot] origin-first writer configured");
```
- Replace the old sync-watchdog block (the `SYNC_WATCH_MS` setInterval added 2026-06-17) with a mirror-refresh loop:
```typescript
  // Pull external changes (Hannes' direct-mode pushes, Obsidian) into the read
  // mirror periodically. Own writes already updated the mirror post-commit.
  const MIRROR_REFRESH_MS = Number(process.env.MIRROR_REFRESH_MS ?? "45000");
  setInterval(() => void refreshMirror(), MIRROR_REFRESH_MS).unref();
  console.log(`[boot] mirror refresh every ${Math.round(MIRROR_REFRESH_MS / 1000)}s`);
```

- [ ] **Step 10: Run the full suite + typecheck**

Run: `npm run typecheck`
Expected: clean (every former `markDirty`/`flushNow`/`getSyncStatus` consumer — tools, jobs, **and index.ts** — now resolved).
Run: `npm test`
Expected: full suite green. Tool tests that asserted fs side-effects may need a fake writer injected via `setWriter(...)` in their setup — if a tool test fails because no writer is configured, add in its `beforeEach`:
```typescript
import { setWriter } from "../src/lib/writer_singleton.js";
import { makeWriter } from "../src/lib/writes.js";
import { createFakeGitHub } from "../src/lib/github.js";
// in beforeEach: setWriter(makeWriter(createFakeGitHub(seedFiles), async () => {}));
```

- [ ] **Step 11: Commit the whole write-path switch**

```bash
git add src/lib/git.ts src/lib/writer_singleton.ts src/lib/sync_status.ts src/lib/vault.ts src/server.ts src/index.ts src/tools src/jobs tests/sync_status.test.ts
git commit -m "feat(writes): route all tools+jobs+boot through origin-first writer; mirror is read-only"
```

---

## Task 6: Dockerfile + README cleanup (retire SSH)

**Files:** `Dockerfile`, `README.md` (if it documents SSH/auto-push)

- [ ] **Step 1: Drop `openssh-client` from the runtime stage**

In `Dockerfile`, change:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
```
to:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
```
(`git` + `ca-certificates` stay for the HTTPS mirror fetch; SSH is gone.)

- [ ] **Step 2: Update README**

Replace any "auto-push via SSH / 30s debounce" description with: "writes go origin-first via the GitHub API (`GITHUB_TOKEN`); the local clone is a read-only mirror refreshed via HTTPS." Document the env: `GITHUB_TOKEN`, `VAULT_REPO_REMOTE` (HTTPS), `VAULT_REPO_BRANCH`, `MIRROR_REFRESH_MS`, `SEMANTIC_INDEX_PATH`. Remove `SSH_KEY_PATH`, `PUSH_DEBOUNCE_MS`.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile README.md
git commit -m "chore(docker): drop openssh-client; document API-write env"
```

---

## Task 7: Final verification + deploy handoff

- [ ] **Step 1: Full green gate**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite green (incl. the new `github_fake`, `transforms`, `writes` tests and the rewritten `sync_status`).

- [ ] **Step 2: Index-path safety note**

Confirm `resolveIndexPath` still asserts the index lives OUTSIDE the repo — with `reset --hard` this is now load-bearing (an in-repo index would be wiped by every refresh). Update the comment in `src/lib/index_singleton.ts` from "would be auto-committed by the 30s debounce" to "would be wiped by the mirror's `git reset --hard`". Commit:
```bash
git add src/lib/index_singleton.ts
git commit -m "docs(index): index path must stay outside repo — reset --hard would wipe it"
```

- [ ] **Step 3: Operator setup (Hannes, manual)** — execute the "Operator-Setup" section of the spec, in order: create the fine-grained PAT → set Coolify env (`GITHUB_TOKEN`, HTTPS `VAULT_REPO_REMOTE`, `SEMANTIC_INDEX_PATH`) + volumes (new index-cache volume, drop `ssh`) → push `main` → Coolify redeploy.

- [ ] **Step 4: Live verification (post-redeploy)**
  - `curl https://mcp.verdara-homegrow.de/healthz` → `{"status":"ok","sync":{...,"stale":false}}`.
  - A test `quick_dump "healthz-test"` lands on GitHub within seconds (synchronous) — confirm the commit on `origin/main`.
  - A direct-mode push by Hannes appears in search within `MIRROR_REFRESH_MS`.
  - Logs: no `[git] mirror refresh failed`; no SSH errors.

- [ ] **Step 5: Retire the SSH deploy key** — only after Step 4 passes: GitHub repo → Settings → Deploy keys → delete the `vault-mcp` key.

---

## Self-review notes (author)

- **Spec coverage:** write-path (T1–T3,T5), read-mirror+refresh (T4,T5-boot), auth/HTTPS+PAT (T4,T6,T7), error/CAS (T1,T3), transforms+Append-RMW-Race kill (T2,T3), EACCES via index volume (T7/operator), /healthz write-health (T4), tests (each task). All spec sections map to a task.
- **Append-RMW-Race:** closed by routing every write through the single origin CAS (no concurrent local read-modify-write).
- **Type consistency:** `FileChange`, `GitHubClient`, `RefMovedError`, `Writer`, `makeWriter`, `getWriter`, `getWriteHealth`, `evaluateSync(SyncState)` are defined once and reused as named.
- **Conscious descopes** are listed under "Out of scope" (reset↔reconcile lock, webhook, batching) — not hidden gaps.

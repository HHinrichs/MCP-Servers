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

  async function apiCall(method: string, url: string, body?: unknown): Promise<Response> {
    return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function json<T>(res: Response): Promise<T> {
    if (!res.ok) throw new Error(`github ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  return {
    async getHead(): Promise<Head> {
      const ref = await json<{ object: { sha: string } }>(
        await apiCall("GET", `${base}/git/ref/heads/${opts.branch}`),
      );
      const commit = await json<{ tree: { sha: string } }>(
        await apiCall("GET", `${base}/git/commits/${ref.object.sha}`),
      );
      return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
    },

    async getFileContent(path: string, ref: string): Promise<string | null> {
      const res = await apiCall(
        "GET",
        `${base}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${ref}`,
      );
      if (res.status === 404) return null;
      const data = await json<{ content: string; encoding: string }>(res);
      return Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf8");
    },

    async commitFiles(baseCommitSha: string, changes: FileChange[], message: string): Promise<string> {
      const baseCommit = await json<{ tree: { sha: string } }>(
        await apiCall("GET", `${base}/git/commits/${baseCommitSha}`),
      );
      const tree = await Promise.all(
        changes.map(async (c) => {
          if (c.delete) return { path: c.path, mode: "100644", type: "blob", sha: null };
          const blob = await json<{ sha: string }>(
            await apiCall("POST", `${base}/git/blobs`, { content: c.content ?? "", encoding: "utf-8" }),
          );
          return { path: c.path, mode: "100644", type: "blob", sha: blob.sha };
        }),
      );
      const newTree = await json<{ sha: string }>(
        await apiCall("POST", `${base}/git/trees`, { base_tree: baseCommit.tree.sha, tree }),
      );
      const now = new Date().toISOString();
      const commit = await json<{ sha: string }>(
        await apiCall("POST", `${base}/git/commits`, {
          message,
          tree: newTree.sha,
          parents: [baseCommitSha],
          author: { name: opts.authorName, email: opts.authorEmail, date: now },
          committer: { name: opts.authorName, email: opts.authorEmail, date: now },
        }),
      );
      const upd = await apiCall("PATCH", `${base}/git/refs/heads/${opts.branch}`, {
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

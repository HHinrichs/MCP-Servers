/**
 * Section-level semantic index with a content-hash → vector cache.
 *
 * Design (reconcile-on-query): find_similar already read the whole vault per
 * call, so re-reading is not a new cost — only embedding is expensive. We cache
 * vectors by section content hash, so reconcile() re-embeds only genuinely
 * changed/new sections. Rebuilding the entry set from disk every time keeps
 * paths/deletions correct for free across git rebase-pulls, move_note, and
 * direct (Obsidian/Git) edits — none of which go through a write hook.
 *
 * The persisted cache lives OUTSIDE the vault repo (see index.ts guard) so the
 * 30s git debounce never commits it.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { cosine, type Embedder } from "./embeddings.js";

const PERSIST_VERSION = 1;

/**
 * Single tunable source for similarity bands (cosine of L2-normalized e5 vectors).
 * Calibrated 2026-06-13 against the real vault (266 sections): unrelated queries
 * top out at ~0.81 (the e5 anisotropy noise floor), genuinely related content
 * sits 0.85–0.90, and near-duplicates reach 0.90–0.915. So the bands must sit
 * well above the noise floor — an earlier 0.82 floor sat right on top of it and
 * labelled almost everything "verwandt".
 */
export const SIM = {
  /** At/above: thematically related — consider extending. (Noise floor ≈ 0.81.) */
  related: 0.84,
  /** At/above: near-duplicate / essentially the same content. */
  high: 0.90,
  /** Dedup-assist warning floor — only true near-duplicates, not same-topic. */
  dedup: 0.90,
} as const;

export function label(score: number): "sehr ähnlich" | "verwandt" | "eher anders" {
  if (score >= SIM.high) return "sehr ähnlich";
  if (score >= SIM.related) return "verwandt";
  return "eher anders";
}

export interface SearchHit {
  path: string;
  heading: string;
  score: number;
  label: ReturnType<typeof label>;
  snippet: string;
}

export interface SearchOpts {
  limit?: number;
  minScore?: number;
  excludePath?: string;
  filterDir?: string;
  excludeDirs?: string[];
}

interface Entry {
  path: string;
  heading: string;
  hash: string;
  snippet: string;
  vec: Float32Array;
}

interface SeenFile {
  mtimeMs: number;
  sections: { heading: string; hash: string; snippet: string }[];
}

export interface SemanticIndexDeps {
  embedder: Embedder;
  /** Absolute vault repo root. */
  vaultRoot: string;
  /** Absolute path to the persisted cache file — MUST be outside vaultRoot. */
  indexPath: string;
}

const SKIP_DIRS = new Set([".git", ".obsidian"]);

async function walkMd(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(path.join(dir, e.name));
      }
    }
  }
  await walk(root);
  return out;
}

function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function vecToB64(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64");
}

function b64ToVec(b64: string): Float32Array {
  // Copy into a fresh, 4-byte-aligned buffer (Buffer.from may be pool-offset).
  const u8 = Uint8Array.from(Buffer.from(b64, "base64"));
  return new Float32Array(u8.buffer);
}

export interface SemanticIndex {
  init(): Promise<void>;
  reconcile(): Promise<void>;
  searchText(text: string, opts: SearchOpts): Promise<SearchHit[]>;
  search(queryVec: Float32Array, opts: SearchOpts): SearchHit[];
  readonly ready: boolean;
  size(): number;
}

export function createSemanticIndex(deps: SemanticIndexDeps): SemanticIndex {
  const { embedder, vaultRoot, indexPath } = deps;

  const vectorCache = new Map<string, Float32Array>();
  const mtimeSeen = new Map<string, SeenFile>();
  let entries: Entry[] = [];
  let ready = false;
  let persistChain: Promise<void> = Promise.resolve();

  function rel(abs: string): string {
    return path.relative(vaultRoot, abs).replace(/\\/g, "/");
  }

  async function loadPersisted(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(indexPath, "utf8"));
    } catch {
      return; // missing or corrupt → start empty, rebuild on reconcile
    }
    const data = parsed as {
      header?: { modelId?: string; dim?: number; version?: number };
      entries?: { path: string; heading: string; hash: string; snippet: string; vec: string }[];
    };
    const h = data.header;
    if (!h || h.modelId !== embedder.id || h.dim !== embedder.dim || h.version !== PERSIST_VERSION) {
      return; // model/format changed → don't trust persisted vectors
    }
    for (const e of data.entries ?? []) {
      try {
        vectorCache.set(e.hash, b64ToVec(e.vec));
      } catch {
        // skip a bad entry, keep the rest
      }
    }
  }

  function persist(): Promise<void> {
    const header = { modelId: embedder.id, dim: embedder.dim, version: PERSIST_VERSION };
    // Snapshot unique hash→vec for compactness.
    const seen = new Set<string>();
    const persistEntries = entries
      .filter((e) => (seen.has(e.hash) ? false : (seen.add(e.hash), true)))
      .map((e) => ({ path: e.path, heading: e.heading, hash: e.hash, snippet: e.snippet, vec: vecToB64(e.vec) }));
    const payload = JSON.stringify({ header, entries: persistEntries });
    persistChain = persistChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        const tmp = `${indexPath}.tmp`;
        await fs.writeFile(tmp, payload, "utf8");
        await fs.rename(tmp, indexPath); // atomic on same filesystem
      } catch (err) {
        console.error("[semantic_index] persist failed:", err);
      }
    });
    return persistChain;
  }

  async function doReconcile(): Promise<void> {
    const { splitIntoChunks } = await import("./sections.js");
    const files = await walkMd(vaultRoot);
    const present = new Set(files);
    const neededHashes = new Set<string>();
    const next: Entry[] = [];
    let changed = false;

    for (const abs of files) {
      const relPath = rel(abs);
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      const seen = mtimeSeen.get(abs);
      let sections: SeenFile["sections"];
      if (seen && seen.mtimeMs === st.mtimeMs) {
        sections = seen.sections;
      } else {
        changed = true; // new or modified file
        let raw: string;
        try {
          raw = await fs.readFile(abs, "utf8");
        } catch {
          continue;
        }
        const chunks = splitIntoChunks(relPath, raw);
        sections = chunks.map((c) => ({ heading: c.heading, hash: c.hash, snippet: snippetOf(c.text) }));
        // Embed sections whose vector we don't already have (dedup by hash).
        const missing = chunks.filter((c) => !vectorCache.has(c.hash));
        const uniq = new Map<string, string>();
        for (const c of missing) if (!uniq.has(c.hash)) uniq.set(c.hash, c.text);
        if (uniq.size > 0) {
          const hashes = [...uniq.keys()];
          const vecs = await embedder.embedPassages(hashes.map((hh) => uniq.get(hh)!));
          hashes.forEach((hh, i) => vectorCache.set(hh, vecs[i]!));
        }
        mtimeSeen.set(abs, { mtimeMs: st.mtimeMs, sections });
      }
      for (const s of sections) {
        neededHashes.add(s.hash);
        const vec = vectorCache.get(s.hash);
        if (vec) next.push({ path: relPath, heading: s.heading, hash: s.hash, snippet: s.snippet, vec });
      }
    }

    // GC: drop cache vectors and seen-files no longer referenced.
    for (const h of [...vectorCache.keys()]) if (!neededHashes.has(h)) vectorCache.delete(h);
    for (const abs of [...mtimeSeen.keys()]) {
      if (!present.has(abs)) {
        mtimeSeen.delete(abs);
        changed = true; // a file disappeared
      }
    }

    entries = next;
    ready = true;
    // Persist only when content actually changed (keeps per-query reconciles
    // free), and await the durable write so a fresh instance can load it.
    if (changed) await persist();
  }

  // Serialize reconciles via a single-flight chain (mirrors persistChain). The
  // index is a process-global singleton hit by concurrent requests; without
  // this, two reconciles could interleave across the embed await and a racing
  // GC could drop a vector or `entries = next` could clobber a fresh index.
  // A caller arriving after a write still gets a run that STARTS after the
  // previous one finished, so dedup/find_similar see freshly written files.
  let reconcileTail: Promise<void> = Promise.resolve();
  function reconcile(): Promise<void> {
    const run = reconcileTail.then(doReconcile);
    reconcileTail = run.catch(() => {});
    return run;
  }

  function search(queryVec: Float32Array, opts: SearchOpts): SearchHit[] {
    const { limit = 5, minScore = 0, excludePath, filterDir, excludeDirs } = opts;
    const hits: SearchHit[] = [];
    for (const e of entries) {
      if (excludePath && e.path === excludePath) continue;
      if (filterDir && !e.path.startsWith(filterDir)) continue;
      if (excludeDirs && excludeDirs.some((d) => e.path.startsWith(d))) continue;
      const score = cosine(queryVec, e.vec);
      if (score < minScore) continue;
      hits.push({ path: e.path, heading: e.heading, score, label: label(score), snippet: e.snippet });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async function searchText(text: string, opts: SearchOpts): Promise<SearchHit[]> {
    const q = await embedder.embedQuery(text);
    return search(q, opts);
  }

  return {
    async init() {
      await loadPersisted();
      await reconcile();
    },
    reconcile,
    search,
    searchText,
    get ready() {
      return ready;
    },
    size() {
      return entries.length;
    },
  };
}

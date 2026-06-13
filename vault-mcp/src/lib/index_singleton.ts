/**
 * Process-global semantic-index singleton wiring. find_similar and the add_to_*
 * dedup-assist read the configured index via getSemanticIndex(); index.ts builds
 * the real one at boot. Tests inject a fake via setSemanticIndex().
 */

import path from "node:path";
import { createSemanticIndex, type SemanticIndex } from "./semantic_index.js";
import { createTransformersEmbedder } from "./embeddings.js";

let singleton: SemanticIndex | null = null;

export function getSemanticIndex(): SemanticIndex | null {
  return singleton;
}

export function setSemanticIndex(idx: SemanticIndex | null): void {
  singleton = idx;
}

/**
 * Resolve the index file path and assert it lives OUTSIDE the vault repo — a
 * path inside the repo would be committed + pushed by the 30s git debounce
 * (churn + leaking vectors into the synced vault). Throws on violation.
 */
export function resolveIndexPath(vaultRoot: string, envValue?: string): string {
  const indexPath = envValue && envValue.trim() ? envValue.trim() : path.join(path.dirname(vaultRoot), "semantic-index.json");
  const repo = path.resolve(vaultRoot);
  const resolved = path.resolve(indexPath);
  if (resolved === repo || resolved.startsWith(repo + path.sep)) {
    throw new Error(
      `SEMANTIC_INDEX_PATH must be OUTSIDE the vault repo — '${indexPath}' is inside '${vaultRoot}' and would be auto-committed.`,
    );
  }
  return resolved;
}

/** Build and register the real (transformers.js) semantic index for production. */
export function configureRealSemanticIndex(vaultRoot: string): SemanticIndex {
  const indexPath = resolveIndexPath(vaultRoot, process.env.SEMANTIC_INDEX_PATH);
  const idx = createSemanticIndex({ embedder: createTransformersEmbedder(), vaultRoot, indexPath });
  setSemanticIndex(idx);
  return idx;
}

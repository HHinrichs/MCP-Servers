/**
 * Process-global reranker singleton. ask_vault reads the configured reranker via
 * getReranker(); index.ts registers the real one at boot. Tests inject a fake via
 * setReranker(). null = reranking off → ask_vault uses the plain embedding order.
 */

import { createTransformersReranker, type Reranker } from "./reranking.js";

let singleton: Reranker | null = null;

export function getReranker(): Reranker | null {
  return singleton;
}

export function setReranker(r: Reranker | null): void {
  singleton = r;
}

/** Build and register the real (transformers.js) reranker for production. Lazy:
 *  the model only loads on the first ask_vault that actually reranks. */
export function configureRealReranker(): Reranker {
  const r = createTransformersReranker();
  setReranker(r);
  return r;
}

/**
 * Local text-embedding abstraction. The real implementation runs
 * multilingual-e5-small on CPU via @huggingface/transformers + onnxruntime-node,
 * fully inside the container (no API, no network at runtime). Tests use the
 * deterministic FakeEmbedder so the suite stays fast and offline.
 */

export interface Embedder {
  /** Embed documents/notes (E5 'passage:' role). Returns L2-normalized vectors. */
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  /** Embed a search/query text (E5 'query:' role). Returns one L2-normalized vector. */
  embedQuery(text: string): Promise<Float32Array>;
  readonly dim: number;
  /** Stable identity written into the cache header (model + quantization). */
  readonly id: string;
}

// --- Real model configuration (overridable via env for the build-time prefetch) ---

export const MODEL_ID = process.env.EMBED_MODEL_ID ?? "Xenova/multilingual-e5-small";
export const MODEL_DTYPE = process.env.EMBED_MODEL_DTYPE ?? "q8";
export const EMBED_DIM = Number(process.env.EMBED_MODEL_DIM ?? "384");
export const EMBEDDER_ID = `${MODEL_ID}@${MODEL_DTYPE}`;

function l2normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  // Vectors are stored L2-normalized → dot product is the cosine similarity.
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * Real embedder. transformers.js is imported lazily *inside* the factory so that
 * merely importing this module (e.g. in a unit test) never loads the native
 * onnxruntime binary. The pipeline load is promise-memoized against a thundering
 * herd of concurrent first requests.
 */
export function createTransformersEmbedder(): Embedder {
  let pipelinePromise: Promise<(input: string[], opts: unknown) => Promise<{ tolist(): number[][] }>> | null = null;

  const load = async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    if (process.env.MODEL_CACHE_DIR) env.cacheDir = process.env.MODEL_CACHE_DIR;
    // Runtime is offline by default; the build-time prefetch sets EMBED_ALLOW_REMOTE=true.
    env.allowRemoteModels = process.env.EMBED_ALLOW_REMOTE === "true";
    env.allowLocalModels = true;
    // dtype is env-configurable (string); the pipeline accepts a narrow union, so cast.
    const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE } as never);
    return extractor as unknown as (input: string[], opts: unknown) => Promise<{ tolist(): number[][] }>;
  };

  const run = async (texts: string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) return [];
    pipelinePromise ??= load();
    const extractor = await pipelinePromise;
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    // normalize:true already L2-normalizes; we re-normalize defensively (cheap).
    return output.tolist().map((row) => l2normalize(Float32Array.from(row)));
  };

  return {
    dim: EMBED_DIM,
    id: EMBEDDER_ID,
    embedPassages: (texts) => run(texts.map((t) => `passage: ${t}`)),
    embedQuery: async (text) => (await run([`query: ${text}`]))[0]!,
  };
}

/**
 * Deterministic, dependency-free embedder for tests: hashes tokens into a fixed
 * number of dimensions and L2-normalizes. Texts sharing tokens get high cosine,
 * disjoint texts get ~0. Ignores E5 prefixes so embedQuery(x) == embedPassages([x]).
 */
export function createFakeEmbedder(dim = 64): Embedder {
  const embedOne = (text: string): Float32Array => {
    const vec = new Float32Array(dim);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const tok of tokens) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      const idx = h % dim;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    return l2normalize(vec);
  };
  return {
    dim,
    id: "fake@v1",
    embedPassages: async (texts) => texts.map(embedOne),
    embedQuery: async (text) => embedOne(text),
  };
}

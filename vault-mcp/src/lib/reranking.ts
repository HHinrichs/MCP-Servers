/**
 * Local cross-encoder reranking abstraction. The real implementation runs a
 * multilingual reranker (default bge-reranker-v2-m3) on CPU via
 * @huggingface/transformers + onnxruntime-node, fully inside the container
 * (no API, no network at runtime). Tests use the deterministic FakeReranker.
 *
 * A reranker scores each (query, passage) pair for relevance — higher means
 * more relevant. It is used as the 2nd stage in ask_vault's retrieve→rerank
 * pipeline; ask_vault only orders by these scores, so raw logits are fine.
 */

export interface Reranker {
  /** Relevance score per passage (higher = more relevant), in input order. */
  rerank(query: string, passages: string[]): Promise<number[]>;
  /** Stable identity (model + quantization), for logging/diagnostics. */
  readonly id: string;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Deterministic, dependency-free reranker for tests: scores each passage by the
 * number of its tokens that also appear in the query. No model load. Lets
 * ask_vault tests assert that reranking reorders candidates by overlap.
 */
export function createFakeReranker(): Reranker {
  return {
    id: "fake-reranker@v1",
    rerank: async (query, passages) => {
      const q = new Set(tokenize(query));
      return passages.map((p) =>
        tokenize(p).reduce((n, tok) => n + (q.has(tok) ? 1 : 0), 0),
      );
    },
  };
}

// --- Real model configuration (overridable via env, also for the build-time prefetch) ---

export const RERANK_MODEL_ID = process.env.RERANK_MODEL_ID ?? "onnx-community/bge-reranker-v2-m3-ONNX";
export const RERANK_MODEL_DTYPE = process.env.RERANK_MODEL_DTYPE ?? "q8";
export const RERANKER_ID = `${RERANK_MODEL_ID}@${RERANK_MODEL_DTYPE}`;

type LoadedReranker = {
  tokenizer: (texts: string[], opts: unknown) => unknown;
  model: (inputs: unknown) => Promise<{ logits: { tolist(): number[][] } }>;
};

/**
 * Real cross-encoder reranker. transformers.js is imported lazily *inside* the
 * factory so merely importing this module never loads onnxruntime. The model load
 * is promise-memoized against a thundering herd of concurrent first requests.
 * Runtime is offline by default; the build-time prefetch sets RERANK_ALLOW_REMOTE=true.
 */
export function createTransformersReranker(): Reranker {
  let modelPromise: Promise<LoadedReranker> | null = null;

  const load = async (): Promise<LoadedReranker> => {
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
    if (process.env.MODEL_CACHE_DIR) env.cacheDir = process.env.MODEL_CACHE_DIR;
    env.allowRemoteModels = process.env.RERANK_ALLOW_REMOTE === "true";
    env.allowLocalModels = true;
    const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL_ID);
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, {
      dtype: RERANK_MODEL_DTYPE,
    } as never);
    return { tokenizer, model } as unknown as LoadedReranker;
  };

  const rerank = async (query: string, passages: string[]): Promise<number[]> => {
    if (passages.length === 0) return [];
    modelPromise ??= load();
    const { tokenizer, model } = await modelPromise;
    // Cross-encoder: encode the (query, passage) pairs in one batch, read the relevance logit.
    const inputs = tokenizer(
      passages.map(() => query),
      { text_pair: passages, padding: true, truncation: true },
    );
    const { logits } = await model(inputs);
    // bge-reranker is single-label (num_labels=1) → logits shape [N, 1]; the raw logit
    // is all ask_vault needs (it only orders by it). Higher = more relevant.
    return logits.tolist().map((row) => row[0] ?? 0);
  };

  return { id: RERANKER_ID, rerank };
}

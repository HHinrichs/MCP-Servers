// Build-time model prefetch: downloads the embedding model into a cache dir so
// the runtime image works fully offline (env.allowRemoteModels=false at runtime).
// Must request the SAME model id + dtype the runtime uses (see src/lib/embeddings.ts).
const MODEL_ID = process.env.EMBED_MODEL_ID || "Xenova/multilingual-e5-small";
const MODEL_DTYPE = process.env.EMBED_MODEL_DTYPE || "q8";
const CACHE = process.env.MODEL_CACHE_DIR || "/app/.model-cache";

(async () => {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = CACHE;
  env.allowRemoteModels = true;
  env.allowLocalModels = true;
  console.log(`[prefetch] downloading ${MODEL_ID} (${MODEL_DTYPE}) -> ${CACHE}`);
  const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE });
  const out = await extractor(["passage: warmup"], { pooling: "mean", normalize: true });
  const dim = out.tolist()[0].length;
  console.log(`[prefetch] ok, embedding dim=${dim}`);

  // Reranker model (ask_vault 2nd stage). Best-effort: a failure here must NOT
  // break the image build — it only means reranking is off at runtime (ask_vault
  // falls back to embedding order). Must match src/lib/reranking.ts.
  if (process.env.RERANK_ENABLED !== "false") {
    try {
      const RERANK_MODEL_ID = process.env.RERANK_MODEL_ID || "onnx-community/bge-reranker-v2-m3-ONNX";
      const RERANK_MODEL_DTYPE = process.env.RERANK_MODEL_DTYPE || "q8";
      console.log(`[prefetch] downloading reranker ${RERANK_MODEL_ID} (${RERANK_MODEL_DTYPE})`);
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@huggingface/transformers");
      const tok = await AutoTokenizer.from_pretrained(RERANK_MODEL_ID);
      const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, { dtype: RERANK_MODEL_DTYPE });
      const inputs = tok(["query"], { text_pair: ["passage"], padding: true, truncation: true });
      const { logits } = await model(inputs);
      console.log(`[prefetch] reranker ok, logits dims=${JSON.stringify(logits.dims)}`);
    } catch (e) {
      console.error(`[prefetch] RERANKER prefetch FAILED — reranking will be OFF at runtime (ask_vault falls back to embedding order): ${e?.message || e}`);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error("[prefetch] failed:", e);
  process.exit(1);
});

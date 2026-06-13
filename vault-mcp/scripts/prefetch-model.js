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
  process.exit(0);
})().catch((e) => {
  console.error("[prefetch] failed:", e);
  process.exit(1);
});

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# libgomp1 is needed already in the builder: the build-time model prefetch runs
# a real onnxruntime-node inference, which dlopens libgomp.so.1. Without it the
# prefetch RUN below fails and no image is produced.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# Pre-download the embedding model into a cache dir so the runtime image needs
# NO network. Must match the model id + dtype used at runtime (src/lib/embeddings.ts).
RUN mkdir -p /app/.model-cache \
    && MODEL_CACHE_DIR=/app/.model-cache node scripts/prefetch-model.js

FROM node:22-bookworm-slim AS runtime
# libgomp1: onnxruntime-node links OpenMP and bookworm-slim does not ship it
# (without it the first inference throws 'libgomp.so.1: cannot open shared object').
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/.model-cache ./.model-cache

ENV NODE_ENV=production
ENV PORT=3000
# Offline embedding: load the bundled model, never fetch from HuggingFace.
ENV MODEL_CACHE_DIR=/app/.model-cache
ENV EMBED_ALLOW_REMOTE=false
# Offline reranker too: load the bundled cross-encoder, never fetch from HuggingFace.
ENV RERANK_ALLOW_REMOTE=false
EXPOSE 3000

# Node 22 ships global fetch — no curl/wget needed in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Non-root user 'node' is provided by the base image
USER node

CMD ["node", "dist/index.js"]

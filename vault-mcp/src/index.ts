import cron from "node-cron";
import { buildServer } from "./server.js";
import { ensureRepoCloned, vaultPath, refreshMirror } from "./lib/git.js";
import { configureRealWriter } from "./lib/writer_singleton.js";
import { configureRealSemanticIndex } from "./lib/index_singleton.js";
import { configureRealReranker } from "./lib/reranker_singleton.js";
import { runDailyRecap } from "./jobs/daily_recap.js";
import { runInboxCuration } from "./jobs/inbox_curation.js";

const PORT = Number(process.env.PORT ?? "3000");
const TZ = process.env.TZ ?? "Europe/Berlin";

async function main(): Promise<void> {
  console.log(`[boot] vault-mcp starting (tz=${TZ}, port=${PORT})`);

  // 1. Make sure the vault is cloned and up to date.
  await ensureRepoCloned();
  console.log("[boot] vault repo ready");

  // 1b. Configure the origin-first writer (all tool/job writes go through it).
  configureRealWriter();
  console.log("[boot] origin-first writer configured");

  // 2. Boot the MCP server.
  const { app } = await buildServer();
  app.listen(PORT, () => {
    console.log(`[boot] listening on 0.0.0.0:${PORT}`);
  });

  // 2b. Semantic index: configure synchronously (validates the index path is
  // outside the repo — fail fast on misconfig), then build it in the BACKGROUND.
  // Blocking listen() on the first full-corpus embed would trip the healthcheck
  // into a restart loop. find_similar / dedup fall back to TF-IDF until ready.
  if (process.env.SEMANTIC_SEARCH !== "off") {
    try {
      const idx = configureRealSemanticIndex(vaultPath());
      void idx
        .init()
        .then(() => console.log(`[semantic] index ready (${idx.size()} sections)`))
        .catch((e) => console.error("[semantic] init failed — find_similar uses TF-IDF fallback:", e));
    } catch (e) {
      console.error("[semantic] disabled (config error):", e);
    }
    // ask_vault 2nd-stage reranker: register the lazy cross-encoder (the model
    // loads on the first ask_vault that reranks, not at boot). ask_vault falls
    // back to embedding order if it is disabled or fails.
    if (process.env.RERANK_ENABLED !== "false") {
      try {
        const r = configureRealReranker();
        console.log(`[rerank] enabled (${r.id}, lazy)`);
      } catch (e) {
        console.error("[rerank] disabled (config error):", e);
      }
    } else {
      console.log("[rerank] disabled via RERANK_ENABLED=false");
    }
  } else {
    console.log("[semantic] disabled via SEMANTIC_SEARCH=off");
  }

  // 3. Schedule background jobs.
  // 03:00 Berlin — runs 1h after Hannes' mental day ends (he works up to ~02:00).
  // Scope: last 24h of bot commits, written into <yesterday>.md.
  cron.schedule(
    "0 3 * * *",
    () => {
      void runDailyRecap().catch((e) => console.error("[daily_recap] failed:", e));
    },
    { timezone: TZ },
  );
  // 04:00 Berlin — staggered after the recap so they don't trip over each other.
  cron.schedule(
    "0 4 * * *",
    () => {
      void runInboxCuration().catch((e) => console.error("[inbox_curation] failed:", e));
    },
    { timezone: TZ },
  );
  console.log("[boot] cron jobs scheduled (daily_recap 03:00, inbox_curation 04:00)");

  // 4. Pull external changes (Hannes' direct-mode pushes, Obsidian) into the
  // read mirror periodically. Own writes already updated the mirror post-commit.
  const MIRROR_REFRESH_MS = Number(process.env.MIRROR_REFRESH_MS ?? "45000");
  setInterval(() => void refreshMirror(), MIRROR_REFRESH_MS).unref();
  console.log(`[boot] mirror refresh every ${Math.round(MIRROR_REFRESH_MS / 1000)}s`);
}

main().catch((e) => {
  console.error("[boot] fatal:", e);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[boot] SIGTERM, shutting down");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[boot] SIGINT, shutting down");
  process.exit(0);
});

import cron from "node-cron";
import { buildServer } from "./server.js";
import { ensureRepoCloned } from "./lib/git.js";
import { runDailyRecap } from "./jobs/daily_recap.js";
import { runInboxCuration } from "./jobs/inbox_curation.js";

const PORT = Number(process.env.PORT ?? "3000");
const TZ = process.env.TZ ?? "Europe/Berlin";

async function main(): Promise<void> {
  console.log(`[boot] vault-mcp starting (tz=${TZ}, port=${PORT})`);

  // 1. Make sure the vault is cloned and up to date.
  await ensureRepoCloned();
  console.log("[boot] vault repo ready");

  // 2. Boot the MCP server.
  const { app } = await buildServer();
  app.listen(PORT, () => {
    console.log(`[boot] listening on 0.0.0.0:${PORT}`);
  });

  // 3. Schedule background jobs.
  cron.schedule(
    "0 22 * * *",
    () => {
      void runDailyRecap().catch((e) => console.error("[daily_recap] failed:", e));
    },
    { timezone: TZ },
  );
  cron.schedule(
    "0 3 * * *",
    () => {
      void runInboxCuration().catch((e) => console.error("[inbox_curation] failed:", e));
    },
    { timezone: TZ },
  );
  console.log("[boot] cron jobs scheduled");
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

import { flushNow, getGit, markDirty } from "../lib/git.js";
import { appendUnderSection, dailyFile, todayBerlin } from "../lib/vault.js";

/** Write a recap of what changed in the vault today, scoped to commits authored by us. */
export async function runDailyRecap(): Promise<void> {
  const today = todayBerlin();
  console.log(`[daily_recap] running for ${today}`);

  const git = getGit();
  // Get commit log for today, just from the bot author so user's own pushes don't double up.
  const log = await git.log([
    "--since=midnight",
    `--author=${process.env.GIT_AUTHOR_EMAIL ?? "mcp@verdara-homegrow.de"}`,
  ]);

  if (log.total === 0) {
    console.log("[daily_recap] no commits today, skipping");
    return;
  }

  // Build a friendly recap from commit subjects.
  const counts = new Map<string, number>();
  for (const c of log.all) {
    const firstLine = c.message.split("\n")[0]?.split(":")[0]?.trim() || "vault";
    counts.set(firstLine, (counts.get(firstLine) ?? 0) + 1);
  }
  const lines = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `- **${cat}**: ${n} Eintrag/Einträge`);

  const block =
    `_Auto-generiert um ${todayBerlin()} 22:00._\n\n` +
    `Heute wurden ${log.total} Commit(s) vom Vault-MCP geschrieben:\n\n` +
    lines.join("\n") +
    `\n`;

  await appendUnderSection(dailyFile(today), "Tagesübersicht (auto)", block, {
    title: today,
    tags: ["daily"],
  });
  markDirty(`daily_recap ${today}`);
  await flushNow();
  console.log("[daily_recap] done");
}

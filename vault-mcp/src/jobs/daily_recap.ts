import { flushNow, getGit, markDirty } from "../lib/git.js";
import { appendUnderSection, dailyFile, timestampBerlin } from "../lib/vault.js";

/** YYYY-MM-DD for "yesterday" in Europe/Berlin. */
function yesterdayBerlin(): string {
  const now = new Date();
  // Subtract 24h. Berlin timezone is handled by the formatter, the offset diff
  // across DST is harmless (we just want the calendar date of "the day before").
  const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(y);
}

/**
 * Daily recap. Runs at 03:00 Europe/Berlin (covering Hannes' "mental day"
 * which extends until 02:00). Scope: commits authored by the bot in the
 * last 24h (yesterday 03:00 → today 03:00). Output: a section in
 * 05 Daily Notes/<yesterday>.md so the wrapped-up day has a recap before
 * Hannes wakes up.
 */
export async function runDailyRecap(): Promise<void> {
  const yesterday = yesterdayBerlin();
  console.log(`[daily_recap] running for ${yesterday} (mental day ${yesterday})`);

  const git = getGit();
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const log = await git.log([
    `--since=${sinceIso}`,
    `--author=${process.env.GIT_AUTHOR_EMAIL ?? "mcp@verdara-homegrow.de"}`,
  ]);

  if (log.total === 0) {
    console.log("[daily_recap] no bot commits in the last 24h, skipping");
    return;
  }

  // Categorise by the prefix before the first ':' or '@' in the commit subject.
  const counts = new Map<string, number>();
  for (const c of log.all) {
    const firstLine = c.message.split("\n")[0] ?? "vault";
    const category =
      firstLine.split(/[:@]/)[0]?.trim() || firstLine.slice(0, 32);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const lines = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `- **${cat}**: ${n} Eintrag/Einträge`);

  const block =
    `_Auto-generiert am ${timestampBerlin()} für den mentalen Tag ${yesterday} (Zeitfenster: die letzten 24 Stunden vor dem Lauf)._\n\n` +
    `Im letzten Tag wurden ${log.total} Commit(s) vom Vault-MCP geschrieben:\n\n` +
    lines.join("\n") +
    `\n`;

  await appendUnderSection(dailyFile(yesterday), "Tagesübersicht (auto)", block, {
    title: yesterday,
    tags: ["daily"],
  });
  markDirty(`daily_recap ${yesterday}`);
  await flushNow();
  console.log("[daily_recap] done");
}

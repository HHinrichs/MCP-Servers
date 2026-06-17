import { z } from "zod";
import { getWriter } from "../lib/writer_singleton.js";
import { appendUnderSectionContent } from "../lib/transforms.js";
import { dailyFile, relFromVault, timestampBerlin, todayBerlin } from "../lib/vault.js";

export const updateDailyTool = {
  name: "update_daily",
  description:
    "Append a timestamped entry to today's daily note (05 Daily Notes/YYYY-MM-DD.md). The file is created if it doesn't exist. Use for daily logs, decisions made today, things to remember.",
  inputSchema: {
    text: z.string().min(1).describe("Free-form Markdown to append to today's daily note."),
  },
  handler: async ({ text }: { text: string }) => {
    const stamp = timestampBerlin();
    const today = todayBerlin();
    await getWriter().writeToOrigin(
      relFromVault(dailyFile(today)),
      (raw) => appendUnderSectionContent(raw, null, `### ${stamp}\n\n${text}\n`, { title: today, tags: ["daily"] }),
      `update_daily ${today}`,
    );
    return {
      content: [{ type: "text" as const, text: `Daily Note für ${today} aktualisiert.` }],
    };
  },
};

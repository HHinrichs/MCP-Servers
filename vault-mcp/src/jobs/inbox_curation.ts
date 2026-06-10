import { promises as fs } from "node:fs";
import { flushNow, markDirty } from "../lib/git.js";
import {
  curationFile,
  ensureDir,
  inboxFile,
  readIfExists,
  todayBerlin,
  writeMarkdown,
} from "../lib/vault.js";

/**
 * Simple keyword-based suggestion engine. We deliberately keep it dumb and
 * transparent: the user can see why the bot suggests what. No LLM call here —
 * that costs API tokens and adds non-determinism. Hannes (or any LLM client
 * calling move_note) decides.
 */
const KEYWORD_RULES: Array<{ pattern: RegExp; target: string }> = [
  { pattern: /\bhomegrow\b/i, target: "02 Projekte/Homegrow Controller.md" },
  { pattern: /\bastro\b|\bwebsite\b/i, target: "02 Projekte/Website.md" },
  { pattern: /\bcoolify\b/i, target: "03 Bereiche/Coolify/Coolify.md" },
  { pattern: /\bhostinger\b/i, target: "03 Bereiche/Hostinger/Hostinger.md" },
  { pattern: /\bnginx\b/i, target: "04 Ressourcen/Nginx/Nginx.md" },
  { pattern: /\bfastapi\b/i, target: "04 Ressourcen/FastAPI/FastAPI.md" },
  { pattern: /\braspberry\b|\bgpio\b|\bpinout\b/i, target: "04 Ressourcen/Raspberry Pi/Raspberry Pi.md" },
  { pattern: /\bsensor\b|\batlas\b|\bez0?o?\b/i, target: "04 Ressourcen/Atlas EZO Sensoren/Atlas EZO Sensoren.md" },
  { pattern: /\bsign\b|\btar\b|\bdeploy.?key\b/i, target: "04 Ressourcen/Code-Signing/Code-Signing.md" },
  { pattern: /\bmcp\b|\btool\b|\bclaude.?code\b/i, target: "04 Ressourcen/Claude Code Workflows/Claude Code Workflows.md" },
];

interface InboxEntry {
  header: string;
  body: string;
  timestamp: Date | null;
}

function parseEntries(content: string): InboxEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: InboxEntry[] = [];
  let header: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (header !== null) {
      entries.push({
        header,
        body: body.join("\n").trim(),
        timestamp: parseTimestamp(header),
      });
    }
  };
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      flush();
      header = m[1] ?? null;
      body = [];
    } else if (header !== null) {
      body.push(line);
    }
  }
  flush();
  return entries;
}

function parseTimestamp(header: string): Date | null {
  // Expected format: 'YYYY-MM-DD HH:MM' (from timestampBerlin)
  const m = header.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  // Treat as Berlin local time; Date constructor needs ISO.
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+01:00`);
}

function suggestTarget(text: string): string | null {
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(text)) return rule.target;
  }
  return null;
}

export async function runInboxCuration(): Promise<void> {
  console.log("[inbox_curation] running");
  const inbox = await readIfExists(inboxFile());
  if (!inbox) {
    console.log("[inbox_curation] no inbox, skipping");
    return;
  }

  const entries = parseEntries(inbox);
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const stale = entries.filter(
    (e) => e.timestamp !== null && now - e.timestamp.getTime() >= ONE_DAY_MS,
  );

  if (stale.length === 0) {
    console.log("[inbox_curation] no stale entries (>24h), skipping");
    return;
  }

  const today = todayBerlin();
  const sections = stale
    .map((e) => {
      const target = suggestTarget(e.body + " " + e.header);
      const targetLine = target
        ? `→ Vorschlag: \`${target}\` (move_note nutzen)`
        : `→ Vorschlag: _keine eindeutige Zuordnung, manuell entscheiden_`;
      return `### ${e.header}\n\n${e.body}\n\n${targetLine}`;
    })
    .join("\n\n---\n\n");

  const content =
    `\n_Auto-generiert am ${today} 03:00 — ältere Inbox-Einträge mit Routing-Vorschlägen._\n` +
    `Verschiebt nichts automatisch. Du (oder ein LLM-Client mit \`move_note\`) entscheidet.\n\n` +
    `${stale.length} Eintrag/Einträge älter als 24 Stunden:\n\n` +
    sections +
    `\n`;

  const path = curationFile();
  await ensureDir(path);
  await writeMarkdown(
    path,
    { tags: ["inbox", "kuratierung"], erstellt: today, updated: today },
    `\n# Inbox-Kuratierung\n${content}`,
  );
  markDirty(`inbox_curation: ${stale.length} stale entries`);
  await flushNow();
  console.log("[inbox_curation] done");
}

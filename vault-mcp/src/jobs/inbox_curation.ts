import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { getWriter } from "../lib/writer_singleton.js";
import { createNoteContent } from "../lib/transforms.js";
import {
  VAULT_DIRS,
  curationFile,
  relFromVault,
  todayBerlin,
  vaultPath,
} from "../lib/vault.js";

/**
 * Simple keyword-based suggestion engine. We deliberately keep it dumb and
 * transparent: the user can see why the bot suggests what. No LLM call here —
 * that costs API tokens and adds non-determinism. Hannes (or any LLM client)
 * decides and executes the triage.
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

function berlinOffsetMinutes(at: Date): number {
  const tz =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      timeZoneName: "shortOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 60;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2] ?? "1") * 60 + Number(m[3] ?? "0"));
}

/** Parse 'YYYY-MM-DD HHMM <Titel>.md' as Europe/Berlin local time. */
export function parseInboxFilename(name: string): Date | null {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2}) .+\.md$/);
  if (!m) return null;
  const guess = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
  return new Date(guess - berlinOffsetMinutes(new Date(guess)) * 60_000);
}

function suggestTarget(text: string): string | null {
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(text)) return rule.target;
  }
  return null;
}

function isTriagable(name: string): boolean {
  return name.endsWith(".md") && !name.startsWith("_") && name !== "Brain Dump.md";
}

export async function runInboxCuration(): Promise<void> {
  console.log("[inbox_curation] running");
  const dir = vaultPath(VAULT_DIRS.inbox);
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter(isTriagable).sort();
  } catch {
    console.log("[inbox_curation] no inbox dir, skipping");
    return;
  }

  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const stale: Array<{ name: string; body: string }> = [];
  for (const name of names) {
    const ts = parseInboxFilename(name);
    let ms: number | null = ts ? ts.getTime() : null;
    if (ms === null) {
      try {
        ms = (await fs.stat(path.join(dir, name))).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - ms < ONE_DAY_MS) continue;
    try {
      const parsed = matter(await fs.readFile(path.join(dir, name), "utf8"));
      stale.push({ name, body: parsed.content.trim() });
    } catch {
      stale.push({ name, body: "" });
    }
  }

  if (stale.length === 0) {
    console.log("[inbox_curation] no stale notes (>24h), skipping");
    return;
  }

  const today = todayBerlin();
  const sections = stale
    .map((e) => {
      const target = suggestTarget(e.name + " " + e.body);
      const targetLine = target
        ? `→ Vorschlag: Inhalt nach \`${target}\` übernehmen (add_to_*), danach \`01 Inbox/${e.name}\` per move_note nach \`06 Archiv/Inbox/\` verschieben.`
        : `→ Vorschlag: _keine eindeutige Zuordnung, manuell entscheiden._`;
      return `### ${e.name.replace(/\.md$/, "")}\n\n${e.body.slice(0, 400)}\n\n${targetLine}`;
    })
    .join("\n\n---\n\n");

  const content =
    `\n_Auto-generiert am ${today} — Inbox-Notizen älter als 24 Stunden mit Routing-Vorschlägen._\n` +
    `Verschiebt nichts automatisch. Du (oder ein LLM-Client) entscheidet.\n\n` +
    `${stale.length} Notiz(en) älter als 24 Stunden:\n\n` +
    sections +
    `\n`;

  await getWriter().writeToOrigin(
    relFromVault(curationFile()),
    () => createNoteContent({ tags: ["inbox", "kuratierung"], erstellt: today }, `\n# Inbox-Kuratierung\n${content}`),
    `inbox_curation: ${stale.length} stale notes`,
  );
  console.log("[inbox_curation] done");
}

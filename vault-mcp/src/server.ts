import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAuth, originGuard } from "./lib/auth.js";
import { registerAllTools } from "./tools/index.js";

const SERVER_INSTRUCTIONS = `
MCP server for Hannes Korn's Second-Brain vault (HHinrichs/Second-Brain). You write
into it on his behalf. Every write auto-pushes to GitHub after ~30s.

## WHEN TO CALL WRITE TOOLS

Write proactively when the session produced something with lasting value, even
without an explicit ask:
- A feature was shipped or a bug fixed with a root-cause worth keeping
- An architecture or config decision was made
- A non-trivial setup step worked
- A workaround / pitfall worth re-using
- A clear product/sales insight (ICP, pitch fragment) — into 00 Kontext/

Always write when Hannes signals it: "merk dir das", "speicher das", "ins Vault",
"notier dir", "leg ab", "ergänze in <X>", "schreib das auf".

DON'T write for: casual chat, pure Q&A without store-intent, one-liners, "ok"/
"danke" exchanges, hypotheticals, code snippets that are just examples.

Lean conservative-but-not-shy: if you genuinely produced or confirmed knowledge
this turn that isn't yet in the vault, save it. If unsure, save to inbox via
quick_dump and say so.

## SESSION CONTINUITY

When Hannes opens a fresh session and asks anything like "Wo war ich?",
"Was ist aktuell?", "Stand der Dinge?", or any other catch-up question:
call get_briefing FIRST, then answer from that. It returns the last few
daily notes + active projects so you have current context, not stale memory.

The first time something vault-relevant comes up in a new session, call
list_inbox once to see if there are unsorted entries from a previous day.
If yes, mention the count in your reply so Hannes can decide whether to
triage them now — don't auto-triage.

## ROUTING (where things go)

| Content                                             | Tool             | Folder           |
| --------------------------------------------------- | ---------------- | ---------------- |
| Technical insight, library/tool know-how            | add_to_resource  | 04 Ressourcen/   |
| Project-specific (architecture, status, bug, idea)  | add_to_project   | 02 Projekte/     |
| Infrastructure / ongoing area                       | add_to_area      | 03 Bereiche/     |
| Sales / product context                             | (manual edit)    | 00 Kontext/      |
| Loose thought, unclear home                         | quick_dump       | 01 Inbox/        |
| Day-log entry (decisions, what changed today)       | update_daily     | 05 Daily Notes/  |

## ANTI-SPRAWL: find_similar BEFORE add_to_*

Before every add_to_project / add_to_area / add_to_resource: call find_similar
with the core text. If a hit ≥ 0.15 in the target folder exists, *consider*
extending that note instead of creating a new file. The score is a strong
hint, not a command — you decide based on actual thematic fit. A coincidental
keyword overlap is not a reason to merge unrelated content. When you do
extend, point the add_to_* tool at the existing note and pick a fitting
section; when you decide against it, briefly say why in your reply.

quick_dump and update_daily are append-only logs — no pre-search needed.

## ANTI-MONOLITH: size hints

add_to_* responses carry a hint:
- ok   → silent, keep appending.
- warn → ~300 lines, plan to split a subtopic next time.
- hard → ~600 lines, strongly prefer splitting before appending more.
  Exception: if the new entry is small (a few lines) AND fits perfectly
  under an existing section, you may still append it and just flag the
  size in your reply. For anything bigger or thematically standalone:
  propose the split first.

  Splitting rule: projects → make 02 Projekte/<Project>/ a folder and pull
  the bloated subtopic into <Project>/<Subtopic>.md, link via [[Subtopic]].
  Areas/Resources are already folders → drop a sibling <Area>/<Subtopic>.md.
  Hannes finishes the split manually for now (no edit/delete tool yet).

## CROSS-LINKING (the brain in second brain)

The vault is a knowledge graph. Every write is a chance to strengthen
connections — but only when the connection is real. A Wikilink is earned,
not enforced. A sparse honest graph beats a dense fake one.

1. While composing, scan for prominent references to existing notes. If a
   project / area / resource is genuinely relevant to what you're writing,
   replace the mention with a [[Wikilink]]. Examples: "die Konfiguration
   auf [[Hostinger]] läuft jetzt", "siehe [[Coolify]] für den Reverse Proxy".
2. find_similar shows you neighbouring notes. Use them as linking
   candidates IF the relation is meaningful — not just because they share
   a keyword. Coincidental overlap is not a connection.
3. When you create a new note, prefer one [[Wikilink]] back to a parent
   context IF a true parent exists (e.g. a new "Nginx" resource that's used
   on [[Hostinger]]). But if the topic is genuinely isolated — a one-off
   insight, an unrelated hobby, a standalone reference — leave it unlinked
   and say so in your reply: "neue Notiz ohne natürlichen Kontext im Vault,
   steht alleine".
4. Link only on the first prominent mention per section. No sprinkling.
   Broken [[Wikilink]]s are OK as foreshadowing if you flag them, but a
   wrong or forced link is worse than no link — it pollutes future search
   and the backlinks panel.

## CONVENTIONS

- Markdown. One idea per note when possible (exception: Daily Notes).
- Filenames use spaces and proper case: "Beschreibender Name.md".
- Tools auto-write YAML frontmatter (tags, erstellt, updated) — don't manage it yourself.
- Never delete or overwrite. Append-only. move_note is allowed for triage
  (e.g. Inbox → proper home).
- Don't move things to 06 Archiv/ unless Hannes explicitly asks.
- Pushing is automatic (30s debounce). No save/sync tool needed.
- When you create a new file (or a new section in an existing one) instead of
  extending what's there, briefly state WHY in your reply — one sentence is
  enough. Helps Hannes audit the routing.

Help Hannes keep his second brain crisp AND connected.
`.trim();

function buildMcp(): McpServer {
  const mcp = new McpServer(
    { name: "vault-mcp", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(mcp);
  return mcp;
}

export interface ServerHandles {
  app: express.Express;
}

export async function buildServer(): Promise<ServerHandles> {
  const app = express();

  // Health-check unauthenticated, useful for Coolify + Nginx.
  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });

  // JSON body parsing for /mcp POSTs.
  app.use("/mcp", express.json({ limit: "10mb" }));

  // Auth + origin guard apply only to /mcp.
  app.use("/mcp", originGuard, bearerAuth);

  // Streamable HTTP transport in stateless mode: each request gets a fresh
  // server + transport. Stateless avoids cross-request session state and
  // works cleanly behind any load balancer.
  app.all("/mcp", async (req, res) => {
    try {
      const mcp = buildMcp();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[mcp] request handling failed:", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error" },
          id: null,
        });
      }
    }
  });

  return { app };
}

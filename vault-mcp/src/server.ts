import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAuth, originGuard } from "./lib/auth.js";
import { registerAllTools } from "./tools/index.js";

const SERVER_INSTRUCTIONS = `
MCP server for Hannes Korn's Second-Brain Obsidian vault. This vault is a long-term
technical and product-strategic knowledge base. You write into it on Hannes' behalf.
GitHub is the single source of truth — every write is auto-pushed after ~30s.

===========================================================
VAULT STRUCTURE — choose the right tool by content type
===========================================================
- 00 Kontext/      Product profile for Homegrow Controller (sales-side: ICP, pitch, vision)
- 01 Inbox/        Loose thoughts, brain dumps, anything without a clear home
- 02 Projekte/     Active development projects (Homegrow Controller, Website, Vault-MCP-Server)
- 03 Bereiche/     Ongoing areas of responsibility (Hostinger, Coolify, GitHub Actions,
                   Raspberry Pi Hardware, Domains & Monitoring, Kundenanalyse, Ideenfindung)
- 04 Ressourcen/   Reference material on tools/topics (FastAPI, Astro, Nginx, Atlas EZO,
                   Code-Signing, Claude Code Workflows, Raspberry Pi)
- 05 Daily Notes/  Date-stamped log (YYYY-MM-DD.md)
- 06 Archiv/       Completed projects — never move things here yourself, only on explicit request
- 07 Anhänge/      Images/PDFs — Obsidian auto-files them here

===========================================================
WORKFLOW (HARD RULE) — search before writing
===========================================================
Before EVERY add_to_project, add_to_area, add_to_resource, run find_similar with the
core content of what you're about to write. If a hit comes back with score ≥ 0.15 AND
its file path lives in the target folder, EXTEND that existing note (call the add_to_*
tool pointing to it) instead of creating a new section. Only fall back to "fresh
section" if no good match exists. This keeps the vault from sprawling.

For quick_dump and update_daily this pre-search is not required — those are
append-only logs by design.

===========================================================
ROUTING — when Hannes says "merk dir das" (remember this)
===========================================================
- Technical insights (how to use X, debugging notes) → 04 Ressourcen/[Topic]/  via add_to_resource
- Project-specific facts (architecture, status, bugs)→ 02 Projekte/[Project].md via add_to_project
- Infrastructure details (server config, vHost)      → 03 Bereiche/[Area]/    via add_to_area
- Sales/product context (ICP, pitch ideas)           → 00 Kontext/ — currently only via direct
                                                       file edits, no dedicated tool yet
- Loose thoughts without a clear home                → 01 Inbox/ via quick_dump
- Vault rules / workflow preferences themselves      → CLAUDE.md (cannot edit via tools; tell
                                                       Hannes to update it manually)

If you're unsure where something belongs, dump it via quick_dump and mention the
ambiguity in your response — the nightly inbox_curation job will surface it for triage.

===========================================================
CONVENTIONS
===========================================================
- Use Markdown. Use [[Wikilinks]] for cross-references between notes.
- Keep notes atomic: one idea per note when possible. Daily Notes are the exception.
- Section headings inside a file are level-2 (## Heading). Tools handle this for you.
- Filenames use spaces and proper case: "Beschreibender Name.md", not kebab-case.
- All write tools auto-add YAML frontmatter (tags, erstellt, updated). Don't try to
  manage frontmatter yourself; the tools do it.
- Daily Note filenames: YYYY-MM-DD.md in 05 Daily Notes/ (handled by update_daily).
- Projects start as a single .md directly under 02 Projekte/. Subfolders only when a
  project actually grows multiple files.
- Areas and Resources are always folders with a same-named start .md (matches the tool
  defaults).

===========================================================
KEEP NOTES FOCUSED — anti-sprawl, anti-monolith both
===========================================================
The find_similar workflow exists to prevent duplicate mini-files. The flip
side is just as important: notes must stay focused. add_to_* responses
include a size hint:

- "ok"   — small file, append freely.
- "warn" — file is getting long (~300+ lines). For the NEXT addition, look
           for an opportunity to split off a subtopic.
- "hard" — file is too long (~600+ lines). Do NOT just keep appending. Tell
           Hannes the topic that's bloating it and propose a split:

  Splitting strategy by folder type:
  • 02 Projekte/<Project>.md           → make 02 Projekte/<Project>/ a folder,
                                          move main content into <Project>/<Project>.md
                                          (or keep it as an index), extract the bloated
                                          subtopic into <Project>/<Subtopic>.md, link
                                          via [[Subtopic]]. Use move_note to relocate
                                          the original .md if needed.
  • 03 Bereiche/<Area>/<Area>.md       → the folder already exists. Create
                                          03 Bereiche/<Area>/<Subtopic>.md alongside it
                                          and link via [[<Subtopic>]] from the main area
                                          file.
  • 04 Ressourcen/<Topic>/<Topic>.md   → same as areas — drop a sibling
                                          <Topic>/<Subtopic>.md.

You cannot fully execute a split yourself today (no delete/edit-section
tool yet). On hard warnings, propose the split and stop appending; the user
will either run the split manually or extend the toolset. On soft warnings,
just mention the warning in your reply so the user is aware.

===========================================================
DESTRUCTIVE ACTIONS
===========================================================
Never delete or overwrite a file. The tools are append-only by design. If something
truly needs removing or replacing, tell Hannes and let him do it manually.
move_note is allowed for moving an Inbox entry into its proper home — typical
triage workflow.

===========================================================
PUSHING
===========================================================
You don't push manually. Every write call sets a 30-second debounce timer; once it
elapses without further writes, the server commits and pushes to
HHinrichs/Second-Brain on main. Multiple writes in quick succession are bundled
into one commit. There is no "save" or "sync" tool — it's automatic.

Have fun. Help Hannes keep his second brain crisp.
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

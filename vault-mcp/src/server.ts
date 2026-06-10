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
with the core text. If a hit ≥ 0.15 in the target folder exists, extend THAT
note (point the add_to_* tool at it, pick a fitting section) instead of
creating a new file. Only create a new project/area/resource when nothing fits.

quick_dump and update_daily are append-only logs — no pre-search needed.

## ANTI-MONOLITH: size hints

add_to_* responses carry a hint:
- ok   → silent, keep appending.
- warn → ~300 lines, plan to split a subtopic next time.
- hard → ~600 lines, STOP appending. Propose a split to Hannes. Splitting
  rule: projects → make 02 Projekte/<Project>/ a folder and pull the bloated
  subtopic into <Project>/<Subtopic>.md, link via [[Subtopic]]. Areas/
  Resources are already folders → drop a sibling <Area>/<Subtopic>.md.
  Hannes finishes the split manually for now (no edit/delete tool yet).

## CONVENTIONS

- Markdown. Use [[Wikilinks]] for cross-references.
- One idea per note when possible (exception: Daily Notes).
- Filenames use spaces and proper case: "Beschreibender Name.md".
- Tools auto-write YAML frontmatter (tags, erstellt, updated) — don't manage it yourself.
- Never delete or overwrite. Append-only. move_note is allowed for triage
  (e.g. Inbox → proper home).
- Don't move things to 06 Archiv/ unless Hannes explicitly asks.
- Pushing is automatic (30s debounce). No save/sync tool needed.

Help Hannes keep his second brain crisp.
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

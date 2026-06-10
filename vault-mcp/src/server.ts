import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAuth, originGuard } from "./lib/auth.js";
import { registerAllTools } from "./tools/index.js";

export interface ServerHandles {
  app: express.Express;
  mcp: McpServer;
}

export async function buildServer(): Promise<ServerHandles> {
  const mcp = new McpServer(
    { name: "vault-mcp", version: "0.1.0" },
    {
      instructions: [
        "MCP server for Hannes' Second-Brain Obsidian vault.",
        "",
        "Use quick_dump for capturing loose thoughts. Use add_to_project / add_to_area / add_to_resource",
        "for context-specific notes. Use update_daily for time-stamped daily entries.",
        "Use search_notes and read_note before adding to a project/area to find the right target.",
        "Use list_inbox and move_note to triage older inbox entries.",
        "",
        "All write tools auto-push to GitHub after ~30s of inactivity. Don't worry about pushing manually.",
      ].join("\n"),
    },
  );

  registerAllTools(mcp);

  const app = express();

  // Health-check unauthenticated, useful for Coolify + Nginx.
  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });

  // Auth + origin guard apply only to /mcp.
  app.use("/mcp", originGuard, bearerAuth);

  // Streamable HTTP transport, stateless mode: each request creates a transient
  // transport. Simpler than session-based, and fine for stateless tool calls.
  app.all("/mcp", async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
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

  // JSON body for /mcp POSTs; must be after the transport (transport reads stream)?
  // Actually StreamableHTTPServerTransport expects parsed body when present.
  // We register json parsing only on /mcp to keep raw-body issues localized.
  app.use("/mcp", express.json({ limit: "10mb" }));

  return { app, mcp };
}

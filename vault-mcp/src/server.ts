import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAuth, originGuard } from "./lib/auth.js";
import { registerAllTools } from "./tools/index.js";

const SERVER_INSTRUCTIONS = [
  "MCP server for Hannes' Second-Brain Obsidian vault.",
  "",
  "Use quick_dump for capturing loose thoughts. Use add_to_project / add_to_area / add_to_resource",
  "for context-specific notes. Use update_daily for time-stamped daily entries.",
  "Use search_notes and read_note before adding to a project/area to find the right target.",
  "Use list_inbox and move_note to triage older inbox entries.",
  "",
  "All write tools auto-push to GitHub after ~30s of inactivity. Don't worry about pushing manually.",
].join("\n");

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

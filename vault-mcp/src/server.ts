import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAuth, originGuard } from "./lib/auth.js";
import { loadInstructions } from "./lib/instructions.js";
import { registerAllTools } from "./tools/index.js";
import { getWriteHealth } from "./lib/writes.js";
import { evaluateSync } from "./lib/sync_status.js";

// Server instructions live in the vault itself: AGENTS.md in the vault root
// is the single source of truth and is loaded per request. Editing that file
// changes the rules for every client without a server redeploy.
function buildMcp(instructions: string): McpServer {
  const mcp = new McpServer(
    { name: "vault-mcp", version: "0.1.0" },
    { instructions },
  );
  registerAllTools(mcp);
  return mcp;
}

export interface ServerHandles {
  app: express.Express;
}

export async function buildServer(): Promise<ServerHandles> {
  const app = express();

  // Health-check unauthenticated, useful for Coolify + Nginx. ALWAYS returns
  // 200 for liveness — a sync stall must not fail the check (that would cause a
  // container restart loop that can't resolve a content conflict). The stall
  // signal lives in the body as `sync.stale`; monitor that, not the status code.
  app.get("/healthz", (_req, res) => {
    const sync = evaluateSync(getWriteHealth(), Date.now());
    res.json({ status: "ok", sync });
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
      const mcp = buildMcp(await loadInstructions());
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

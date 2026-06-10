import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { quickDumpTool } from "./quick_dump.js";
import { addToProjectTool } from "./add_to_project.js";
import { addToAreaTool } from "./add_to_area.js";
import { addToResourceTool } from "./add_to_resource.js";
import { updateDailyTool } from "./update_daily.js";
import { searchNotesTool } from "./search_notes.js";
import { readNoteTool } from "./read_note.js";
import { listInboxTool } from "./list_inbox.js";
import { moveNoteTool } from "./move_note.js";

const ALL_TOOLS = [
  quickDumpTool,
  addToProjectTool,
  addToAreaTool,
  addToResourceTool,
  updateDailyTool,
  searchNotesTool,
  readNoteTool,
  listInboxTool,
  moveNoteTool,
];

export function registerAllTools(server: McpServer): void {
  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // The SDK accepts a Zod raw shape and converts to JSON Schema for the client.
        inputSchema: tool.inputSchema as never,
      },
      tool.handler as never,
    );
  }
  console.log(`[tools] registered ${ALL_TOOLS.length} tools`);
}

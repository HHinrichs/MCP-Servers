import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { quickDumpTool } from "./quick_dump.js";
import { addToProjectTool } from "./add_to_project.js";
import { addToAreaTool } from "./add_to_area.js";
import { addToResourceTool } from "./add_to_resource.js";
import { addToContextTool } from "./add_to_context.js";
import { updateDailyTool } from "./update_daily.js";
import { searchNotesTool } from "./search_notes.js";
import { findSimilarTool } from "./find_similar.js";
import { askVaultTool } from "./ask_vault.js";
import { readNoteTool } from "./read_note.js";
import { listInboxTool } from "./list_inbox.js";
import { moveNoteTool } from "./move_note.js";
import { splitNoteTool } from "./split_note.js";
import { getBriefingTool } from "./get_briefing.js";
import { editSectionTool } from "./edit_section.js";
import { deleteSectionTool } from "./delete_section.js";
import { deleteNoteTool } from "./delete_note.js";
import { createNoteTool } from "./create_note.js";

const ALL_TOOLS = [
  quickDumpTool,
  addToProjectTool,
  addToAreaTool,
  addToResourceTool,
  addToContextTool,
  updateDailyTool,
  searchNotesTool,
  findSimilarTool,
  askVaultTool,
  readNoteTool,
  listInboxTool,
  moveNoteTool,
  splitNoteTool,
  getBriefingTool,
  editSectionTool,
  deleteSectionTool,
  deleteNoteTool,
  createNoteTool,
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

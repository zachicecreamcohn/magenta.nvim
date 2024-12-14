import { FileTool, GetFileToolUseRequest } from "./getFile.js";
import { InsertTool, InsertToolUseRequest } from "./insert.js";

export const TOOLS = {
  get_file: new FileTool(),
  insert: new InsertTool(),
};

export type ToolRequest = GetFileToolUseRequest | InsertToolUseRequest;

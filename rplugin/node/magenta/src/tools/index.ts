import { FileTool, GetFileToolUseRequest } from "./getFile.ts";
import { InsertTool, InsertToolUseRequest } from "./insert.ts";

export const TOOLS = {
  get_file: new FileTool(),
  insert: new InsertTool(),
};

export type ToolRequest = GetFileToolUseRequest | InsertToolUseRequest;

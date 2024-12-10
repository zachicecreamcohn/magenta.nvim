import { FileTool, GetFileToolUseRequest } from "./getFile";
import { InsertTool, InsertToolUseRequest } from "./insert";

export const TOOLS = {
  get_file: new FileTool(),
  insert: new InsertTool(),
};

export type ToolRequest = GetFileToolUseRequest | InsertToolUseRequest;

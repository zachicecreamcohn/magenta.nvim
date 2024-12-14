import { FileToolProcess, GetFileToolUseRequest } from "./getFile.js";
import { InsertProcess, InsertToolUseRequest } from "./insert.js";
import { Context } from "../types.js";

export type ToolRequest = GetFileToolUseRequest | InsertToolUseRequest;

export interface Tool {
  execRequest(request: ToolRequest, context: Context): Promise<ToolProcess>;
}

export type ToolProcess = FileToolProcess | InsertProcess;

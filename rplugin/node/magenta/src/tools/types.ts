import { FileToolProcess, GetFileToolUseRequest } from "./getFile.ts";
import { InsertProcess, InsertToolUseRequest } from "./insert.ts";
import { Context } from "../types.ts";

export type ToolRequest = GetFileToolUseRequest | InsertToolUseRequest;

export interface Tool {
  execRequest(request: ToolRequest, context: Context): Promise<ToolProcess>;
}

export type ToolProcess = FileToolProcess | InsertProcess;

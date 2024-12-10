import { FileToolProcess, GetFileToolUseRequest } from "./getFile";
import { InsertProcess, InsertToolUseRequest } from "./insert";
import { Context } from "../types";

export type ToolRequest = GetFileToolUseRequest | InsertToolUseRequest;

export interface Tool {
  execRequest(request: ToolRequest, context: Context): Promise<ToolProcess>;
}

export type ToolProcess = FileToolProcess | InsertProcess;

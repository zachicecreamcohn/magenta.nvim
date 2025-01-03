import type { Result } from "../utils/result";
import * as ToolManager from "../tools/toolManager.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type { Nvim } from "bunvim";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "content"
  | "stop_sequence";

export type ProviderMessage = {
  role: "user" | "assistant";
  content: string | Array<ProviderMessageContent>;
};

export type ProviderTextContent = {
  type: "text";
  text: string;
};

export type ProviderToolUseContent = {
  type: "tool_use";
  request: ToolManager.ToolRequest;
};

export type ProviderToolResultContent = {
  type: "tool_result";
  id: ToolManager.ToolRequestId;
  result: Result<string>;
};

export type ProviderToolSpec = {
  name: string;
  description: string;
  input_schema: JSONSchemaType;
};

export type ProviderMessageContent =
  | ProviderTextContent
  | ProviderToolUseContent
  | ProviderToolResultContent;

export interface Provider {
  sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
    onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
  }>;
}

let client: Provider | undefined;

// lazy load so we have a chance to init context before constructing the class
export function getClient(nvim: Nvim): Provider {
  if (!client) {
    client = new AnthropicProvider(nvim);
  }
  return client;
}

export function setClient(c: Provider | undefined) {
  client = c;
}

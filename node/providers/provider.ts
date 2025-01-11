import type { Result } from "../utils/result";
import * as ToolManager from "../tools/toolManager.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type { Nvim } from "bunvim";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { OpenAIProvider } from "./openai.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { MagentaOptions } from "../options.ts";

export const PROVIDER_NAMES = ["anthropic", "openai"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

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

  abort(): void;
}

const clients: Partial<{ [providerName in ProviderName]: Provider }> = {};

// lazy load so we have a chance to init context before constructing the class
export function getClient(
  nvim: Nvim,
  providerName: ProviderName,
  options: MagentaOptions,
): Provider {
  if (!clients[providerName]) {
    switch (providerName) {
      case "anthropic":
        clients[providerName] = new AnthropicProvider(nvim, options.anthropic);
        break;
      case "openai":
        clients[providerName] = new OpenAIProvider(nvim, options.openai);
        break;
      default:
        assertUnreachable(providerName);
    }
  }

  return clients[providerName];
}

export function setClient(providerName: ProviderName, c: Provider | undefined) {
  if (c) {
    clients[providerName] = c;
  } else {
    delete clients[providerName];
  }
}

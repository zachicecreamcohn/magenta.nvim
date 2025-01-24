import type { Result } from "../utils/result";
import * as ToolManager from "../tools/toolManager.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type { Nvim } from "nvim-node";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { OpenAIProvider } from "./openai.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { InlineEditToolRequest } from "../inline-edit/inline-edit-tool.ts";
import type { ReplaceSelectionToolRequest } from "../inline-edit/replace-selection-tool.ts";

export const PROVIDER_NAMES = ["anthropic", "openai"] as const;
export type ProviderSetting =
  | { provider: "anthropic"; model: string }
  | { provider: "openai"; model: string };
export type ProviderName = ProviderSetting["provider"];

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "content"
  | "stop_sequence";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheHits?: number;
  cacheMisses?: number;
};

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
  setModel(model: string): void;
  createStreamParameters(messages: Array<ProviderMessage>): unknown;
  countTokens(messages: Array<ProviderMessage>): Promise<number>;

  inlineEdit(messages: Array<ProviderMessage>): Promise<{
    inlineEdit: Result<InlineEditToolRequest, { rawRequest: unknown }>;
    stopReason: StopReason;
    usage: Usage;
  }>;

  replaceSelection(messages: Array<ProviderMessage>): Promise<{
    replaceSelection: Result<
      ReplaceSelectionToolRequest,
      { rawRequest: unknown }
    >;
    stopReason: StopReason;
    usage: Usage;
  }>;

  sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
    onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage: Usage;
  }>;

  abort(): void;
}

const clients: Partial<{ [providerName in ProviderName]: Provider }> = {};

// lazy load so we have a chance to init context before constructing the class
export function getProvider(
  nvim: Nvim,
  providerSetting: ProviderSetting,
): Provider {
  if (!clients[providerSetting.provider]) {
    switch (providerSetting.provider) {
      case "anthropic":
        clients[providerSetting.provider] = new AnthropicProvider(nvim);
        break;
      case "openai":
        clients[providerSetting.provider] = new OpenAIProvider(nvim);
        break;
      default:
        assertUnreachable(providerSetting);
    }
  }

  const provider = clients[providerSetting.provider]!;
  provider.setModel(providerSetting.model);

  return provider;
}

export function setClient(providerName: ProviderName, c: Provider | undefined) {
  if (c) {
    clients[providerName] = c;
  } else {
    delete clients[providerName];
  }
}

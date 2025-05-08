import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import * as ToolManager from "../tools/toolManager.ts";
import type { Result } from "../utils/result";

export const PROVIDER_NAMES = ["anthropic", "openai", "bedrock"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type ProviderSetting = {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  promptCaching?: boolean;
};

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "content"
  | "aborted"
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
  name: ToolManager.ToolName;
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
  forceToolUse(
    messages: Array<ProviderMessage>,
    spec: ProviderToolSpec,
  ): ProviderRequest;

  sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
  ): ProviderRequest;
}

export interface ProviderRequest {
  abort(): void;
  promise: Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage: Usage;
  }>;
}

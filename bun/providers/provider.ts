import type Anthropic from "@anthropic-ai/sdk";
import type { Result } from "../utils/result";
import * as ToolManager from "../tools/toolManager.ts";
import { AnthropicProviderImpl } from "./anthropic.ts";
import type { Nvim } from "bunvim";
import type { Lsp } from "../lsp.ts";

export type StopReason = Anthropic.Message["stop_reason"];

export interface Provider {
  sendMessage(
    messages: Array<Anthropic.MessageParam>,
    onText: (text: string) => void,
    onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
  }>;
}

let client: Provider | undefined;

// lazy load so we have a chance to init context before constructing the class
export function getClient(nvim: Nvim, lsp: Lsp): Provider {
  if (!client) {
    client = new AnthropicProviderImpl(nvim, lsp);
  }
  return client;
}

export function setClient(c: Provider | undefined) {
  client = c;
}

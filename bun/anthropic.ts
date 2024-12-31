import Anthropic from "@anthropic-ai/sdk";
import * as ToolManager from "./tools/toolManager.ts";
import { type Result } from "./utils/result.ts";
import type { Nvim } from "bunvim";
import type { Lsp } from "./lsp.ts";

export type StopReason = Anthropic.Message["stop_reason"];

export interface AnthropicClient {
  sendMessage(
    messages: Array<Anthropic.MessageParam>,
    onText: (text: string) => void,
    onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
  }>;
}

class AnthropicClientImpl implements AnthropicClient {
  private client: Anthropic;
  private toolManagerModel;

  constructor(
    private nvim: Nvim,
    lsp: Lsp,
  ) {
    this.toolManagerModel = ToolManager.init({ nvim, lsp });
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("Anthropic API key not found in config or environment");
    }

    this.client = new Anthropic({
      apiKey,
    });
  }

  async sendMessage(
    messages: Array<Anthropic.MessageParam>,
    onText: (text: string) => void,
    onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
  }> {
    const buf: string[] = [];
    let flushInProgress: boolean = false;

    const flushBuffer = () => {
      if (buf.length && !flushInProgress) {
        const text = buf.join("");
        buf.splice(0);

        flushInProgress = true;

        try {
          onText(text);
        } finally {
          flushInProgress = false;
          setInterval(flushBuffer, 1);
        }
      }
    };

    const stream = this.client.messages
      .stream({
        messages,
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 4096,
        system: `\
You are a coding assistant to a software engineer, inside a neovim plugin called magenta.nvim .
Be concise.
Do not narrate tool use.
You can use multiple tools at once, so try to minimize round trips.
First understand what’s already working - do not change or delete or break existing functionality.
Look for the simplest possible fix.
Avoid introducing unnecessary complexity.
Don’t introduce new technologies without asking.
Follow existing patterns and code structure.`,
        tool_choice: {
          type: "auto",
          disable_parallel_tool_use: false,
        },
        tools: ToolManager.TOOL_SPECS,
      })
      .on("text", (text: string) => {
        buf.push(text);
        flushBuffer();
      })
      .on("error", onError)
      .on("inputJson", (_delta, snapshot) => {
        this.nvim.logger?.debug(
          `anthropic stream inputJson: ${JSON.stringify(snapshot)}`,
        );
      });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response: Anthropic.Message = await stream.finalMessage();

    if (response.stop_reason === "max_tokens") {
      onError(new Error("Response exceeded max_tokens limit"));
    }

    const toolRequests = response.content
      .filter((c): c is ToolManager.ToolRequest => c.type == "tool_use")
      .map((c) => this.toolManagerModel.validateToolRequest(c));
    this.nvim.logger?.debug("toolRequests: " + JSON.stringify(toolRequests));
    this.nvim.logger?.debug("stopReason: " + response.stop_reason);
    return { toolRequests, stopReason: response.stop_reason };
  }
}

let client: AnthropicClient | undefined;

// lazy load so we have a chance to init context before constructing the class
export function getClient(nvim: Nvim, lsp: Lsp): AnthropicClient {
  if (!client) {
    client = new AnthropicClientImpl(nvim, lsp);
  }
  return client;
}

export function setClient(c: AnthropicClient | undefined) {
  client = c;
}
